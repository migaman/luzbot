'use strict';

var express = require('express');  
var bodyParser = require('body-parser');  
var request = require('request');  
var app = express();
const pg = require('pg');

const PORT = process.env.PORT;

// Optional. You will see this name in eg. 'ps' or 'top' command
process.title = 'luzbot';


// websocket and http servers
var webSocketServer = require('websocket').server;
var http = require('http');


/**
 * Global variables
 */
// latest 100 messages
var history = [ ];
// list of currently connected clients (users)
var clients = [ ];


let Wit = null;
let log = null;
try {
  // if running from repo
  Wit = require('../').Wit;
  log = require('../').log;
} catch (e) {
  Wit = require('node-wit').Wit;
  log = require('node-wit').log;
}

// Variables are defined in Heroku
const WIT_TOKEN = process.env.WIT_TOKEN;
const FB_PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

//Needs feature Dyno Metadata (https://stackoverflow.com/questions/7917523/how-do-i-access-the-current-heroku-release-version-programmatically)
const VERSION = process.env.HEROKU_RELEASE_VERSION;

//const { Client } = require('pg');



/**
 * Helper function for escaping input strings
 */
function htmlEntities(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Array with some colors
var colors = [ 'green', 'blue', 'magenta', 'purple', 'plum', 'orange' ];
// ... in random order
colors.sort(function(a,b) { return Math.random() > 0.5; } );


app.use(bodyParser.urlencoded({extended: false}));  
app.use(bodyParser.json());  

//app.listen(PORT);
app.use(express.static(__dirname + "/"))

//console.log('Listening on :' + PORT + '...');


/**
 * HTTP server
 */
/*var server = http.createServer(function(request, response) {
    // Not important for us. We're writing WebSocket server, not HTTP server
});
*/
//initialize a simple http server
var server = http.createServer(app);


server.listen(PORT, function() {
    console.log((new Date()) + " Server is listening on port " + PORT);
});

/**
 * WebSocket server
 */
var wsServer = new webSocketServer({
    // WebSocket server is tied to a HTTP server. WebSocket request is just
    // an enhanced HTTP request. For more info http://tools.ietf.org/html/rfc6455#page-6
    httpServer: server
});


// Server frontpage
/*app.get('/', function (req, res) {  
    res.send('This is TestBot Server');
});*/

// Facebook Webhook
app.get('/webhook', function (req, res) {  
    if (req.query['hub.verify_token'] === 'luzbot_hans') {
        res.send(req.query['hub.challenge']);
    } else {
        res.send('Invalid verify token');
    }
});


// handler receiving messages
app.post('/webhook', function (req, res) {  
    var events = req.body.entry[0].messaging;
    for (var i = 0; i < events.length; i++) {
        var event = events[i];
        if (event.message && event.message.text) {
						
			// Yay! We got a new message!
			// We retrieve the Facebook user ID of the sender
			const sender = event.sender.id;
			
			// We retrieve the user's current session, or create one if it doesn't exist
			// This is needed for our bot to figure out the conversation history
			const sessionId = findOrCreateSession(sender);
		
			var question = event.message.text;
		
			console.log('New message detected, text: ' + question);
			console.log('New message detected, sender: ' + sender);
			
			
			sendBotAnswer(2, sender, question);
			
        }
    }
    res.sendStatus(200);
});



// This callback function is called every time someone tries to connect to the WebSocket server
wsServer.on('request', function(request) {
    console.log((new Date()) + ' Connection from origin ' + request.origin + '.');

    // accept connection - you should check 'request.origin' to make sure that
    // client is connecting from your website
    // (http://en.wikipedia.org/wiki/Same_origin_policy)
    var connection = request.accept(null, request.origin); 
    // we need to know client index to remove them on 'close' event
    var index = clients.push(connection) - 1;
    var userName = false;
    var userColor = false;

    console.log((new Date()) + ' Connection accepted.');

    // send back chat history
    if (history.length > 0) {
        connection.sendUTF(JSON.stringify( { type: 'history', data: history} ));
    }

    // user sent some message
    connection.on('message', function(message) {
        if (message.type === 'utf8') { // accept only text
            if (userName === false) { // first message sent by user is their name
                // remember user name
                userName = htmlEntities(message.utf8Data);
                // get random color and send it back to the user
                userColor = colors.shift();
                connection.sendUTF(JSON.stringify({ type:'color', data: userColor }));
                console.log((new Date()) + ' User is known as: ' + userName
                            + ' with ' + userColor + ' color.');

            } else { // log and broadcast the message
                console.log((new Date()) + ' Received Message from '
                            + userName + ': ' + message.utf8Data);
                
				//Eingegeben Nachricht ausgeben...
				sendMessageNativeBot(message.utf8Data, userName, userColor);
				
                //Sende Bot Anwort...
				var question = message.utf8Data;
				sendBotAnswer(1, 0, question);
				

            }
        }
    });

    // user disconnected
    connection.on('close', function(connection) {
        if (userName !== false && userColor !== false) {
            console.log((new Date()) + " Peer "
                + connection.remoteAddress + " disconnected.");
            // remove user from the list of connected clients
            clients.splice(index, 1);
            // push back user's color to be reused by another user
            colors.push(userColor);
        }
    });

});





// ----------------------------------------------------------------------------
// Messenger API specific code

// See the Send API reference
// https://developers.facebook.com/docs/messenger-platform/send-api-reference

const fbMessage = (id, text) => {
  const body = JSON.stringify({
    recipient: { id },
    message: { text },
  });
  const qs = 'access_token=' + encodeURIComponent(FB_PAGE_ACCESS_TOKEN);
  return fetch('https://graph.facebook.com/me/messages?' + qs, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body,
  })
  .then(rsp => rsp.json())
  .then(json => {
    if (json.error && json.error.message) {
      throw new Error(json.error.message);
    }
    return json;
  });
};

// ----------------------------------------------------------------------------
// Wit.ai bot specific code

// This will contain all user sessions.
// Each session has an entry:
// sessionId -> {fbid: facebookUserId, context: sessionState}
const sessions = {};


const findOrCreateSession = (fbid) => {
  let sessionId;
  // Let's see if we already have a session for the user fbid
  Object.keys(sessions).forEach(k => {
    if (sessions[k].fbid === fbid) {
      // Yep, got it!
      sessionId = k;
    }
  });
  if (!sessionId) {
    // No session found for user fbid, let's create a new one
    sessionId = new Date().toISOString();
    sessions[sessionId] = {fbid: fbid, context: {}};
  }
  return sessionId;
};



// Our bot actions
const actions = {
  send({sessionId}, {text}) {
	console.log('Our bot has something to say!');
    // Our bot has something to say!
    // Let's retrieve the Facebook user whose session belongs to
    const recipientId = sessions[sessionId].fbid;
	console.log('Our bot has something to say!' + recipientId);
    if (recipientId) {
		console.log('// Yay, we found our recipient!');
      // Yay, we found our recipient!
      // Let's forward our bot response to her.
      // We return a promise to let our bot know when we're done sending
      return fbMessage(recipientId, text)
      .then(() => null)
      .catch((err) => {
        console.error(
          'Oops! An error occurred while forwarding the response to',
          recipientId,
          ':',
          err.stack || err
        );
      });
    } else {
      console.error('Oops! Couldn\'t find user for session:', sessionId);
      // Giving the wheel back to our bot
      return Promise.resolve()
    }
  },

};


// Setting up our bot
const wit = new Wit({
  accessToken: WIT_TOKEN,
  actions,
  logger: new log.Logger(log.INFO)
});




//Process JSON for correct answer
function sendAnswer(botType, recipientId, nlpJson) {
	if(nlpJson.hasOwnProperty('entities') && Object.keys(nlpJson.entities).length > 0){
		console.log('property entities exists and has at least one entity');
	
		if (nlpJson['entities']['intent']['0']['value'] === 'temperature_get') {
			var answer = "Die aktuelle Temperatur ist...";
			sendMessage(botType, recipientId, answer);
		}
		else if (nlpJson['entities']['intent']['0']['value'] === 'temperature_set') {
			var answer = "Die neue Temperatur ist ";
			if(nlpJson.entities.hasOwnProperty('temperature')) {
				answer += nlpJson['entities']['temperature']['0']['value'] + ' ' + nlpJson['entities']['temperature']['0']['unit'];
			}
			else {
				answer = "Ich verstehe die neue Temperatur nicht!";
			}
			
			sendMessage(botType, recipientId, answer);
		}
		else if (nlpJson['entities']['intent']['0']['value'] === 'restaurant') {
			var answer = 'Ich zeige dir eine Liste von Restaurants...';

			/* https://github.com/brianc/node-postgres/issues/1352
			Yeah though it's not really documented clients are cheap to instantiate and should be considered 'used up' once they've been disconnected. There's a bit of a state machine inside the client w/ a bunch of event handlers being established after the connect event. Your best bet is going to be to throw the old one away & make a new one. The connection handshake over tcp is the part that takes a little bit of time, but reusing an existing client wouldn't save any time there as reconnecting would still need to happen - it would also introduce additional complexity in ensuring the old event handlers were disposed and the new ones set up correctly. I'll re-open this & add it to the 7.0 milestone to return an error if a client has connect called on it more than once - hopefully that will make things more clear.
			*/
			//TODO: Implement connection pool 
			var pgClient = new pg.Client({
			  connectionString: process.env.DATABASE_URL,
			  ssl: true,
			});

			pgClient.connect();

			var sql = "SELECT resultname FROM results res LEFT OUTER JOIN category cat ON res.idcategory = cat.idcategory LEFT OUTER JOIN subcategory scat ON res.idsubcategory = scat.idsubcategory WHERE category = 'Eating'";
			
			pgClient.query(sql, (err, res) => {
				if (err) throw err;
				for (let row of res.rows) {
					answer += row.resultname + "; ";
				}
				answer += "...Ende der Liste...";
				pgClient.end();
			
				sendMessage(botType, recipientId, answer);
			
			});
			
			
		}
	}
	else {
		var answer = "Ich verstehe deine Anfrage nicht. Sorry.";
		sendMessage(botType, recipientId, answer);
	}

}




function sendBotAnswer(botType, recipientId, question) {
	
	if(question.toUpperCase() == "HI") {
		var answer = "Hi. How are you?";
		sendMessage(botType, recipientId, answer);
	}
	else if(question.toUpperCase() == "VERSION") {
		var answer = "Aktuelle Version ist " + VERSION;
		sendMessage(botType, recipientId, answer);
	}
	else {
		//forward question to wit framework
				
		wit.message(question, {})
			.then((data) => 
			{
				var body = JSON.stringify(data);
				console.log('Wit.ai response: ' + body);
				sendAnswer(botType, recipientId, data);
			})
		.catch(console.error);
	}
}

function sendMessage(botType, recipientId, msg) {
	if(botType == 1) {
		//Native Chat
		sendMessageNativeBot(msg, 'Luzbot', 'red');
	}
	else if(botType == 2) {
		//Facebook Chat
		sendMessageFacebook(recipientId, msg);
	}
}


function sendMessageNativeBot(msg, userName, userColor) {
	// we want to keep history of all sent messages
	var obj = {
		time: (new Date()).getTime(),
		text: htmlEntities(msg),
		author: userName,
		color: userColor
	};
	history.push(obj);
	history = history.slice(-100);

	// broadcast message to all connected clients
	var json = JSON.stringify({ type:'message', data: obj });
	for (var i=0; i < clients.length; i++) {
		clients[i].sendUTF(json);
	}

}



function getAnswer(nlpJson) {
	var answer = "";
	//Process JSON for correct answer

	if (nlpJson['entities']['intent']['0']['value'] === 'temperature_get') {
		answer = "Die aktuelle Temperatur ist...";
	}
	else if (nlpJson['entities']['intent']['0']['value'] === 'temperature_set') {
		answer = "Die neue Temperatur ist " + nlpJson['entities']['temperature']['0']['value'] + ' ' + nlpJson['entities']['temperature']['0']['unit'];
	}
	else if (nlpJson['entities']['intent']['0']['value'] === 'restaurant') {
		pgClient.connect();

		answer = 'Ich zeige dir eine Liste von Restaurants...';
		
		var sql = "SELECT resultname FROM results res LEFT OUTER JOIN category cat ON res.idcategory = cat.idcategory LEFT OUTER JOIN subcategory scat ON res.idsubcategory = scat.idsubcategory WHERE category = 'Eating'";
		
		//'SELECT table_schema,table_name FROM information_schema.tables;'
	
	
		pgClient.query(sql, (err, res) => {
		if (err) throw err;
		for (let row of res.rows) {
			console.log(JSON.stringify(row));
			answer += JSON.stringify(row);
		}
		pgClient.end();
		});
		
		answer += "...Ende der Liste...";
	}
	else {
		answer = "Ich verstehe deine Anfrage nicht. Sorry.";
	}

    return answer;
}

// ----------------------------------------------------------------------------
// Facebook Messenger specific code

//Sends a Message in Facebook Chat
function sendMessageFacebook(recipientId, msg) {  
	var message = {text: msg}; 
    request({
        url: 'https://graph.facebook.com/v2.10/me/messages',
        qs: {access_token: FB_PAGE_ACCESS_TOKEN},
        method: 'POST',
        json: {
            recipient: {id: recipientId},
            message: message,
        }
    }, function(error, response, body) {
        if (error) {
            console.log('Error sending message: ', error);
        } else if (response.body.error) {
            console.log('Error: ', response.body.error);
        }
    });
};
