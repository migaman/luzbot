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
			
			
			sendBotAnswer(2, sender, question, index);
			
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
				sendMessageNativeBot(message.utf8Data, userName, userColor, index);
				
                //Sende Bot Anwort...
				var question = message.utf8Data;
				sendBotAnswer(1, 0, question, index);
				

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
function sendAnswer(botType, recipientId, nlpJson, question, index) {
	//TODO: Implement connection pool 
	//TODO: parametrized query
	
	if(question.toUpperCase() == "HI") {
		var answer = "Hi. How are you?";
		sendMessage(botType, recipientId, answer, index);
	}
	else if(question.toUpperCase() == "VERSION") {
		var answer = "Aktuelle Version ist " + VERSION;
		sendMessage(botType, recipientId, answer, index);
	}
	else if(nlpJson.hasOwnProperty('entities') && Object.keys(nlpJson.entities).length > 0){
		console.log('property entities exists and has at least one entity');
		var intent = nlpJson['entities']['intent']['0']['value'];
						
		var pgClient = new pg.Client({
		  connectionString: process.env.DATABASE_URL,
		  ssl: true,
		});

		pgClient.connect();

		var sql = "SELECT resultname FROM results res LEFT OUTER JOIN category cat ON res.idcategory = cat.idcategory LEFT OUTER JOIN subcategory scat ON res.idsubcategory = scat.idsubcategory WHERE LOWER(category) = LOWER('" + intent  + "')";
		
		pgClient.query(sql, (err, res) => {
			if (err) throw err;
			var answer = "I suggest the following: ";
			for (let row of res.rows) {
				answer += row.resultname + "; ";
			}
			pgClient.end();
			
			if(question.lastIndexOf('data', 0) === 0) {
				//if question starts with data show the wit.ai json
				var result = 'Category: ' + intent + ", json:" + JSON.stringify(nlpJson);
				sendMessage(botType, recipientId, result, index);
			}
			else {
				sendMessage(botType, recipientId, answer, index);
			}
			
		});

	}
	else {
		var answer = "Ich verstehe deine Anfrage nicht. Sorry.";
		sendMessage(botType, recipientId, answer, index);
	}
	
}




function sendBotAnswer(botType, recipientId, question, index) {
	
	//forward question to wit framework
				
	wit.message(question, {})
		.then((data) => 
		{
			var body = JSON.stringify(data);
			console.log('Wit.ai response: ' + body);
			sendAnswer(botType, recipientId, data, question, index);
		})
	.catch(console.error);
	
}

function sendMessage(botType, recipientId, msg, index) {
	if(botType == 1) {
		//Native Chat
		sendMessageNativeBot(msg, 'Luzbot', 'red', index);
	}
	else if(botType == 2) {
		//Facebook Chat
		sendMessageFacebook(recipientId, msg);
	}
}


function sendMessageNativeBot(msg, userName, userColor, index) {
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
	
	//Only for the specific client
	for (var i=0; i < clients.length; i++) {
		if(i == index) {
			clients[i].sendUTF(json);
		}
		
	}

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
