var express = require('express')
var bodyParser = require('body-parser')
var request = require('request')
var app = express()

var client = require('redis').createClient(process.env.REDIS_URL);

client.on('connect', function() {
    console.log('--------- connected to redis server ----------');
});

// if a Redis error occurs, print it to the console
client.on('error', function (err) {
    console.log("Redis error " + err);
});

const PAGE_TOKEN = process.env.PAGE_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const START_TEXT = 'Om te beginnen heb ik de 3S code nodig van je pakje (bv. 3STSMC865396101)';

app.set('port', (process.env.PORT || 5000))

// Process application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({extended: false}))

// Process application/json
app.use(bodyParser.json())

// Index route
app.get('/', function (req, res) {
    res.send('Hello world, I am a chat bot')
})

// for Facebook verification
app.get('/webhook/', function (req, res) {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.send(req.query['hub.challenge'])
    }
    res.send('Error, wrong token')
})

// Spin up the server
app.listen(app.get('port'), function() {
    console.log('running on port', app.get('port'))
})


// API End Point - added by Stefan
app.post('/webhook', function (req, res) {
  var data = req.body;

  // Make sure this is a page subscription
  if (data.object === 'page') {

    // Iterate over each entry - there may be multiple if batched
    data.entry.forEach(function(entry) {
      var pageID = entry.id;
      var timeOfEvent = entry.time;

      // Iterate over each messaging event
      entry.messaging.forEach(function(event) {
        if (event.message) {
          receivedMessage(event);
        } else if (event.postback) {
          receivedPostback(event);
        } else {
          console.log("Webhook received unknown event: ", event);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know
    // you've successfully received the callback. Otherwise, the request
    // will time out and we will keep trying to resend.
    res.sendStatus(200);
  }
});

function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:", 
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var messageId = message.mid;

  var messageText = message.text;
  var messageAttachments = message.attachments;
  
  if (messageText) {

    // If we receive a text message, check to see if it matches a keyword
    // and send back the example. Otherwise, just echo the text we received.
    switch (messageText) {
      case 'Aan de slag':
      case 'Get Started':
      case 'pakje':
        sendTextMessage(senderID, START_TEXT);
        break;

      case 'Nee':
        sendTextMessage(senderID, 'Ok, welke postcode dan? (bv. 2595SN)');
        break;

      case String(messageText.match(/^3S.*/i)):
        client.setex(`${senderID}:3Scode`, messageText, 21600); // expire in 6 hours
        client.get(`${senderID}:postcode`, function (err, res) {
          if (!err && res) {
            postcodePreset(senderID, res);
          } else {
            sendTextMessage(senderID, 'Super! Nou alleen nog de postcode (bv. 2595SN)');
          }
        });
        break;

      case String(messageText.match(/^[1-9][0-9]{3} ?(?!sa|sd|ss)[a-z]{2}$/i)):
        client.setex(`${senderID}:postcode`, messageText, 21600); // expire in 6 hours
        client.get(`${senderID}:3Scode`, function (err, res) {
          if (!err && res) {
            getPackageInfo(senderID, res, messageText);
          } else {
            console.log('could not get s3code', err);
          }
        });
        break;

      default:
        sendTextMessage(senderID, `${messageText}? Ehmm.. me no habla ingles?`);
    }
  } else if (messageAttachments) {
    sendTextMessage(senderID, "Message with attachment received");
  }
}

function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var postback = event.postback;

  console.log("Received postback for user %d and page %d at %d with postback:", 
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(postback));

  switch (postback.payload) {
    case 'PAKJE':
      sendTextMessage(senderID, START_TEXT);
      break;

    case 'FIRST_RUN':
    default:
      sendWelcomeMessage(senderID);
  }
}

function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;
      console.log("Successfully sent generic message with id %s to recipient %s", 
        messageId, recipientId);
    } else {
      console.error("Unable to send message.");
      console.error(response);
      console.error(error);
    }
  });  
}

function getPackageInfo(recipientId, s3code, postcode) {
  const URL = `https://jouw.postnl.nl/web/api/shipmentStatus/${s3code}-NL-${postcode}`;
  console.log(URL);
  request(URL, { json: true }, function (error, response, body) {
    let mssg = 'Ik kon dit pakje niet vinden :(';
    if (!error && response.statusCode == 200) {
      console.log(body);
      const status = body.shipments[s3code].delivery.phase.message;
      console.log(status);
      mssg = `De status van dit pakje is: ${status}`;
    }
    sendTextMessage(recipientId, mssg);  
  }) 
}

function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText
    }
  };

  callSendAPI(messageData);
}

function postcodePreset(recipientId, postcode) {
  const messageData = {
    "recipient":{
      "id": recipientId
    },
    "message":{
      "text": `Is je postcode nog steeds ${postcode}?`,
      "quick_replies":[
        {
          "content_type":"text",
          "title":"Ja",
          "payload": postcode,
        },
        {
          "content_type":"text",
          "title": "Nee",
          "payload": "POSTCODE_AGAIN",
        }
      ]
    }
  };
  callSendAPI(messageData);
}

function sendWelcomeMessage(recipientId) {
  const messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [
          {
            title: "Bezorg status",
            subtitle: "Waar is mijn pakje?",
            buttons: [{
              type: "postback",
              title: "Opvragen Status",
              payload: "PAKJE",
            }],
          }
          ]
        }
      }
    }
  };
  callSendAPI(messageData);
}
