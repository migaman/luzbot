'use strict';

var express = require('express');  
var bodyParser = require('body-parser');  
var request = require('request');  
var app = express();

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
const PORT = process.env.PORT;
//Needs feature Dyno Metadata (https://stackoverflow.com/questions/7917523/how-do-i-access-the-current-heroku-release-version-programmatically)
const VERSION = process.env.HEROKU_RELEASE_VERSION;

const { Client } = require('pg');

const pgClient = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: true,
});


app.use(bodyParser.urlencoded({extended: false}));  
app.use(bodyParser.json());  
app.listen(PORT);
console.log('Listening on :' + PORT + '...');

// Server frontpage
app.get('/', function (req, res) {  
    res.send('This is TestBot Server');
});

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
		
		
			
			if(question.toUpperCase() == "HI") {
				var answer = "Hi. How are you?";
				sendMessage(event.sender.id, answer);
			}
			else if(question.toUpperCase() == "VERSION") {
				var answer = "Aktuelle Version ist " + VERSION;
				sendMessage(event.sender.id, answer);
			}
			else {
				//forward question to wit framework
				console.log('New message detected, text: ' + question);
				console.log('New message detected, sender: ' + sender);
				console.log('New message detected, sessionId: ' + sessionId);
					
				wit.message(question, {})
					.then((data) => 
					{
						var body = JSON.stringify(data);
						console.log('Yay, got Wit.ai response: ' + body);
						var answer = getAnswer(data);
						sendMessage(event.sender.id, answer);
					})
				.catch(console.error);
				
			}
			
			
            
			
			
		
			// Let's forward the message to the Wit.ai Bot Engine
            // This will run all actions until our bot has nothing left to do
            /*wit.runActions(
              sessionId, // the user's current session
              text, // the user's message
              sessions[sessionId].context // the user's current session state
            ).then((context) => {
              // Our bot did everything it has to do.
              // Now it's waiting for further messages to proceed.
              console.log('Waiting for next user messages');

              // Based on the session state, you might want to reset the session.
              // This depends heavily on the business logic of your bot.
              // Example:
              // if (context['done']) {
              //   delete sessions[sessionId];
              // }

              // Updating the user's current session state
              sessions[sessionId].context = context;
            })
            .catch((err) => {
              console.error('Oops! Got an error from Wit: ', err.stack || err);
            })
			*/
			
			
        }
    }
    res.sendStatus(200);
});

//witJSON answer of WIT Engine, i.e.
/*
{
	"_text":"Zeige mir Restaurants"
	,"entities":{"intent":[{"confidence":0.78031343410165,"value":"restaurant"}]}
	,"msg_id":"0xaoNXhmAyWix0sms"
}
*/
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
			answer += "test";
		}
		pgClient.end();
		});
		
		answer += "...Ende der Liste...";
	}
	else {
		answer = "Ich verstehe deine Anfrage nicht. Sorry.";
	}

	/*
	SELECT resultname FROM results res
	LEFT OUTER JOIN category cat ON res.idcategory = cat.idcategory
	LEFT OUTER JOIN subcategory scat ON res.idsubcategory = scat.idsubcategory
	WHERE category = 'Eating'
	*/
	
    return answer;
}


// generic function sending messages
function sendMessage(recipientId, msg) {  
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
  // You should implement your custom actions here
  // See https://wit.ai/docs/quickstart
};


// Setting up our bot
const wit = new Wit({
  accessToken: WIT_TOKEN,
  actions,
  logger: new log.Logger(log.INFO)
});
