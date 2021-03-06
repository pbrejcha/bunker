/**
 * UserController
 *
 * @description :: Server-side logic for managing users
 * @help        :: See http://links.sailsjs.org/docs/controllers
 */

'use strict';
var moment = require('moment');
var Promise = require('bluebird');

var emoticonService = require('./../services/emoticonService');
var userService = require('../services/userService');
var User = require('./../models/User');
var UserSettings = require('./../models/UserSettings');
var RoomMember = require('./../models/RoomMember');
var InboxMessage = require('./../models/InboxMessage');
var Room = require('./../models/Room');
var Message = require('./../models/Message');
var RoomController = require('./RoomController');

// A connecting client will call this endpoint. It should subscribe them to all relevant data and
// return all rooms and user data necessary to run the application.
module.exports.init = function (req, res) {

	var user, userSettings, memberships, inbox, rooms;
	var userIds = [];

	if (!req.session.userId) return res.ok();

	var userId = req.session.userId.toObjectId();
	var socket = req.socket;

	// allows sending async messages back to connected client from server
	socket.join('userself_' + userId);

	// find user sockets
	User.findById(userId, {sockets: 1}).then(function (user) {

		var sockets = user.sockets || [];
		_.remove(sockets, {socketId: req.socket.id});
		sockets.push({socketId: req.socket.id, updatedAt: new Date()});

		return User.findByIdAndUpdate(userId, {
			sockets: sockets,
			connected: true,
			lastConnected: new Date().toISOString(),
			typingIn: null,
			present: true
		}, {'new': true});
	})
		.then(function (updatedUser) {
			req.io.to('user_' + updatedUser._id).emit('user', {
				_id: updatedUser._id,
				verb: 'updated',
				data: updatedUser
			});

			return Promise.join(
				User.findById(userId).lean(),
				UserSettings.findOne({user: userId}).lean(),
				RoomMember.find({user: userId}).sort('roomOrder').populate('room').lean(),
				InboxMessage.find({user: req.session.userId}).sort('-createdAt').limit(20).populate('message').lean()
			);
		})
		.spread((_user, _userSettings, _memberships, _inboxMessages) => {

			user = _user;
			userSettings = _userSettings;
			memberships = _memberships;
			inbox = _inboxMessages;
			var rooms = _(memberships).pluck('room').compact().value();

			// build up a list of userids to fetch from the database
			userIds.pushAll(_(inbox).pluck('message').pluck('author').unique().value());
			userIds.pushAll(_.pluck(memberships, 'user'));

			// de-associate a room from a membership since we set rooms above
			// and fix bad room order data
			_(memberships)
				.reject(membership => !membership.room)
				.each((membership, index) => {
					membership.room = membership.room._id;
					membership.roomOrder = index;
				})
				.value();

			// Setup subscriptions
			socket.join('user_' + userId);
			socket.join('inboxmessage_' + userId);

			_.each(memberships, membership => socket.join('roommember_' + membership._id));
			_.each(rooms, room => socket.join('room_' + room._id));

			return Promise.map(rooms, room => {
				return Promise.join(
					Message.find({room: room._id}).sort('-createdAt').limit(40).lean(),
					RoomMember.find({room: room._id}).lean()
				)
					.spread((messages, members) => {
						userIds.pushAll(_.pluck(messages, 'author'), _.pluck(members, 'user'));

						// Setup subscriptions
						_.each(members, member => socket.join('roommember_' + member._id));
						_.each(_.pluck(members, 'user'), user => socket.join('user_' + user));

						room.$messages = messages;
						room.$members = members;

						return room;
					});
			});
		})
		.then(_rooms => {
			rooms = _rooms;

			// Populate authors
			var userIdStrings = _(userIds).filter().map(userId=> userId.toString()).unique().value();
			return User.find(userIds).select('-plaintextpassword -sockets').lean();
		})

		// compose all the data into an object matching the original vars and return them to the client
		.then(users => res.ok({user, userSettings, memberships, inbox, rooms, users}))
		.catch(res.serverError);
};

// Activity update route. This will respond to PUT /user/current/activity
// This route only allows updates to present, typingIn, and room. It can only be called by the current user.
// Its purpose is to update state changes for the current user (which room are they typing in, are they away,
// which room is active, etc.)
module.exports.activity = function (req, res) {
	var userId = req.session.userId;

	// Only allow updates for the following values
	// There's no need for us to save these in the db, this may change in the future
	var typingIn = req.body.typingIn;
	var present = req.body.present;
	var updates = {
		typingIn: typeof typingIn !== 'undefined' ? typingIn : null,
		present: typeof present !== 'undefined' ? present : true
	};

	var activeRoom = req.body.room;
	var lastMessageId;

	if (typeof activeRoom !== 'undefined') {
		updates.activeRoom = activeRoom;

		User.findById(userId, {activeRoom: 1}).then(user => {
			if (user.activeRoom) {
				Message.findOne({room: user.activeRoom}, {_id: 1}, {
					sort: {$natural: -1},
					limit: 1
				}).lean()
					.then(lastMessage => {
						lastMessageId = lastMessage._id;
						return RoomMember.findOneAndUpdate({
							user: userId,
							room: user.activeRoom
						}, {lastReadMessage: lastMessageId});
					})
					.then(roomMember => {
						req.io.to(`userself_${userId}`).emit('user_roommember', {
							_id: roomMember._id,
							verb: 'updated',
							data: {lastReadMessage: lastMessageId}
						});
					});
			}

			User.findByIdAndUpdate(userId, {activeRoom: activeRoom}).then(_.noop);
			return null;
		});
	}

	req.io.to(`user_${userId}`).emit('user', {_id: userId, verb: 'updated', data: updates});
	res.ok(updates);
};

module.exports.markInboxRead = function (req, res) {
	InboxMessage.update({user: req.session.userId.toObjectId()}, {read: true})
		.then(res.ok)
		.catch(res.serverError);
};

module.exports.clearInbox = function (req, res) {
	InboxMessage.remove({user: req.session.userId.toObjectId()})
		.then(res.ok)
		.catch(res.serverError);
};

module.exports.ping = function (req, res) {
	var userId = req.session.userId.toObjectId();

	// remove currently connected socket from array
	User.findByIdAndUpdate(userId,
		{
			$pull: {
				sockets: {socketId: req.socket.id}
			}
		}
	)
		.then(() => {
			return User.findByIdAndUpdate(userId,
				{
					$push: {
						sockets: {socketId: req.socket.id, updatedAt: new Date()}
					}
				}
			)
		})
		.then(res.ok)
		.catch(res.serverError);
};

// clear inactive users from list
setInterval(function () {
	var expiredSocketDate = moment().subtract(30, 'seconds').toDate();

	User.find({
		connected: true,
		$or: [
			{
				sockets: {
					$elemMatch: {
						updatedAt: {"$lte": expiredSocketDate}
					}
				}
			},
			{
				sockets: {$size: 0}
			}
		]
	})
		.then(users => {
			return Promise.each(users, user => {
				var socket = _.find(user.sockets, socket => {
					return moment(socket.updatedAt).isBefore(expiredSocketDate);
				});
				return userService.disconnectUser(user, (socket || {}).socketId);
			});
		})
		.catch(log.error)
}, 10000);
