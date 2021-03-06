/**
 * RoomController
 *
 * @description :: Server-side logic for managing rooms
 * @help        :: See http://links.sailsjs.org/docs/controllers
 */

var moment = require('moment');
var ObjectId = require('mongodb').ObjectID;
var Promise = require('bluebird');

var RoomMember = require('../models/RoomMember');
var User = require('../models/User');
var Room = require('../models/Room');
var Message = require('../models/Message');

var RoomService = require('../services/RoomService');
var messageService = require('../services/messageService');
var ForbiddenError = require('../errors/ForbiddenError');
var InvalidInputError = require('../errors/InvalidInputError');

// POST /room/:id/message
// Create a new message
module.exports.message = function (req, res) {

	var userId = req.session.userId.toObjectId();
	var roomId = req.body.roomId.toObjectId();
	var currentRoomMember;

	RoomMember.findOne({user: userId, room: roomId}).populate('user')
		.then(roomMember => {
			if (!roomMember) throw new ForbiddenError('Must be a member of this room');
			currentRoomMember = roomMember;

			// Inform clients that use is not busy and typing has ceased
			var notTypingUpdate = {busy: false, typingIn: null, connected: true};
			req.io.to(`user_${userId}`).emit('user', {_id: userId, verb: 'updated', data: notTypingUpdate});

			return Promise.join(
				User.findByIdAndUpdate(userId, notTypingUpdate),
				messageService.createMessage(roomMember, req.body.text)
			);
		})
		.spread((userUpdate, message) => res.ok(message))
		.catch(InvalidInputError, function (err) {
			RoomService.messageUserInRoom(currentRoomMember.user._id, currentRoomMember.room, err.message);
			res.badRequest(err);
		})
		.catch(ForbiddenError, res.forbidden)
		.catch(res.serverError);
};

// GET /room/:id
module.exports.findOne = function (req, res) {
	var pk = actionUtil.requirePk(req);
	Promise.join(
		Room.findOne(pk),
		Message.find({room: pk}).limit(40).populate('author'),
		RoomMember.find({room: pk}).populate('user')
	)
		.spread(function (room, messages, members) {
			room.$messages = messages;
			room.$members = members;
			return room;
		})
		.then(res.ok)
		.catch(res.serverError);
};

// POST /room
// Create a room
module.exports.create = function (req, res) {
	var userId = req.session.userId;
	var name = req.body.name || 'Untitled';
	var room;

	// Create new instance of model using data from params
	Room.create({name: name})
		.then(function (_room) {
			room = _room;

			// Make user an administrator
			return RoomMember.create({room: room._id, user: userId, role: 'administrator'})
		})
		.then(function () {
			res.ok(room.toObject());
		});
};

// GET /room/:id/join
// Join a room
module.exports.join = function (req, res) {
	var roomId = req.body.roomId;
	var userId = req.session.userId;

	Promise.join(
		Room.findById(roomId),
		RoomMember.count({room: roomId, user: userId})
	)
		.spread(function (room, existingRoomMember) {
			if (!room) {
				return new InvalidInputError('Requested room does not exist');
			}

			if (existingRoomMember > 0) {
				// Already exists!
				return RoomMember.findOne({room: roomId, user: userId}).populate('user');
			}

			return RoomMember.create({room: roomId, user: userId})
				.then(function (createdRoomMember) {
					return Promise.join(
						createdRoomMember,
						User.findById(userId).lean(),
						Room.findById(roomId).lean(),
						RoomMember.find({room: roomId}).populate('user').lean()
					);
				})
				.spread(function (createdRoomMember, user, room, roomMembers) {
					req.io.to('room_' + roomId).emit('room', {
						_id: roomId,
						verb: 'updated',
						data: {$members: roomMembers}
					});

					// Create system message to inform other users of this user joining
					RoomService.messageRoom(roomId, user.nick + ' has joined the room');

					// Add subscriptions for requestor
					req.socket.join('room_' + roomId);
					_.each(roomMembers, function (roomMember) {
						req.socket.join('roommember_' + roomMember._id);
						req.socket.join('user_' + roomMember.user._id);
					});

					// Add subscriptions for existing room members
					_.each(req.io.inRoom('room_' + roomId), function (socket) {
						socket.join('roommember_' + createdRoomMember._id);
						socket.join('user_' + userId);
					});

					return room;
				});
		})
		.then(res.ok)
		.catch(InvalidInputError, function (err) {
			res.badRequest(err);
		})
		.catch(res.serverError);
};

// Current user requesting to leave a room
module.exports.leave = function (req, res) {

	var roomId = req.body.roomId.toObjectId();
	var userId = req.session.userId.toObjectId();

	RoomMember.count({room: roomId, user: userId})
		.then(function (existingRoomMember) {

			if (existingRoomMember == 0) {
				return 'ok';
			}

			return RoomMember.remove({room: roomId, user: userId})
				.then(function () {
					return [
						User.findById(userId),
						RoomMember.find({room: roomId}).populate('user')
					];
				})
				.spread(function (user, roomMembers) {
					req.io.to('room_' + roomId).emit('room', {
						_id: roomId,
						verb: 'updated',
						data: {$members: roomMembers}
					});
					req.socket.leave('room_' + roomId);

					RoomService.messageRoom(roomId, user.nick + ' has left the room');
				});
		})
		.then(res.ok)
		.catch(res.serverError);
};

// Get the messages of a room, with optional skip amount
module.exports.messages = function (req, res) {
	var roomId = req.body.roomId.toObjectId();
	var skip = req.body.skip || 0;

	// find finds multiple instances of a model, using the where criteria (in this case the roomId
	// we also want to sort in DESCing (latest) order and limit to 50
	Message.find({room: roomId}).sort('-createdAt').skip(skip).limit(40).populate('author')
		.then(res.ok)
		.catch(res.serverError);
};

// GET /room/:id/history
// Get historical messages of a room
module.exports.history = function (req, res) {
	var roomId = req.body.roomId.toObjectId();
	var startDate = new Date(req.body.startDate);
	var endDate = new Date(req.body.endDate);

	Message.find({room: roomId, createdAt: {'$gte': startDate, '$lt': endDate}})
		.sort('createdAt')
		.populate('author')
		.then(res.ok)
		.catch(res.serverError);
};

// GET /room/:id/media
// Get media messages posted in this room
module.exports.media = function (req, res) {
	var roomId = actionUtil.requirePk(req);
	var mediaRegex = /https?:\/\//gi;

	// Native mongo query so we can use a regex
	Message.native(function (err, messageCollection) {
		if (err) res.serverError(err);

		messageCollection.find({
			room: ObjectId(roomId),
			text: {$regex: mediaRegex}
		}).sort({createdAt: -1}).toArray(function (err, messages) {
			if (err) res.serverError(err);

			res.ok(_.map(messages, function (message) {
				return _(message)
					.pick(['author', 'text', 'createdAt'])
					.extend({_id: message._id})
					.value();
			}));
		});
	});
};
