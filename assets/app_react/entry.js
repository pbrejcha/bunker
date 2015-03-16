require("!style!css!./../styles/default.css");

var Router = require('react-router');
var DefaultRoute = Router.DefaultRoute;
var Route = Router.Route;
var NotFoundRoute = Router.NotFoundRoute;

var Header = require('./components/Header.jsx');
var Lobby = require('./components/Lobby.jsx');
var Room = require('./room/Room.jsx');
var RoomNotFound = require('./room/RoomNotFound.jsx');
var Messages = require('./room/Messages.jsx');
var App = require('./App.jsx');

var routes = (
	<Route name="app" path="/" handler={App}>
		<Route name="rooms" path="/rooms/:roomId" handler={ Room } />
		<DefaultRoute handler={Lobby}/>
	</Route>
);

Router.run(routes, function (Handler) {
	React.render(<Handler/>, document.getElementById('app'));
});


//
//<Route name="room" path="/room" handler={Room}>
//	<Route name="messages" path="/room/:roomId" handler={Messages}/>
//	<DefaultRoute handler={Lobby}/>
//</Route>

//<NotFoundRoute handler={RoomNotFound}/>