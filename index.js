// index.js
const express = require('express');
const app = express();
const port = 8000;
const path = require('path');
const fs = require('fs').promises;
const {authenticate} = require('@google-cloud/local-auth');
const {google} = require('googleapis');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cookieSession = require('cookie-session');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly',"https://www.googleapis.com/auth/gmail.labels","https://www.googleapis.com/auth/gmail.send"];

// Load client secrets from a local file.
// const credentials = JSON.parse(await fs.readFile('credentials.json'));

// let credentials;
// fs.readFile('credentials.json')
//   .then(data => {
//     credentials = JSON.parse(data);
//     // Rest of the code that depends on credentials
//   })
//   .catch(error => {
//     // Handle any errors
//     console.error(error);
//   });


let credentials;
fs.readFile('credentials.json')
  .then(data => {
    credentials = JSON.parse(data);
    // Configure Google strategy
    passport.use(new GoogleStrategy({
      clientID: credentials.web.client_id,
      clientSecret: credentials.web.client_secret,
      callbackURL: credentials.web.redirect_uris[0]
    },
    function(accessToken, refreshToken, profile, cb) {
      // Use the profile info to check if the user is registered in your database
      // Here we just return the profile object
      return cb(null, profile);
    }
  ));
  })
  .catch(error => {
    // Handle any errors
    console.error(error);
  });

// Set up passport and session
app.use(cookieSession({
  name: 'session',
  keys: ['secret'],
  maxAge: 24 * 60 * 60 * 1000 // 24 hours
}));
app.use(passport.initialize());
app.use(passport.session());

// Serialize and deserialize user
passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(user, done) {
  done(null, user);
});

// Configure Google strategy
// passport.use(new GoogleStrategy({
//     clientID: credentials.web.client_id,
//     clientSecret: credentials.web.client_secret,
//     callbackURL: credentials.web.redirect_uris[0]
//   },
//   function(accessToken, refreshToken, profile, cb) {
//     // Use the profile info to check if the user is registered in your database
//     // Here we just return the profile object
//     return cb(null, profile);
//   }
// ));

// Define routes
app.get('/', (req, res) => {
  // Check if user is logged in
  if (req.user) {
    // Render a page with a welcome message and a logout button
    res.send(`Hello ${req.user.displayName}! <a href="/logout">Logout</a>`);
  } else {
    // Render a page with a login button
    res.send(`<a href="/auth/google">Login with Google</a>`);
  }
});

app.get('/auth/google',
  passport.authenticate('google', { scope: SCOPES }));

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login' }),
  function(req, res) {
    // Successful authentication, redirect to home.
    res.redirect('/');
  });

app.get('/logout', (req, res) => {
  // Clear the session cookie and redirect to home
  req.session = null;
  res.redirect('/');
});

app.get('/check-emails', async (req, res) => {
  // Check if user is logged in
  if (req.user) {
    // Get the access token from the user object
    const accessToken = req.user.accessToken;
    // Create an OAuth2 client with the token
    const oauth2Client = new OAuth2(
      credentials.web.client_id,
      credentials.web.client_secret,
      credentials.web.redirect_uris[0]
    );
    oauth2Client.setCredentials({access_token: accessToken});
    // Create a Gmail client with the OAuth2 client
    const gmail = google.gmail({version: 'v1', auth: oauth2Client});
    
    try {
      // Get the list of labels
      const labelsResponse = await gmail.users.labels.list({ userId: 'me' });
      const labels = labelsResponse.data.labels;
      console.log(labels);

      // Check if there is a label named "Replied"
      let repliedLabelId = null;
      for (let label of labels) {
        if (label.name === "Replied") {
          repliedLabelId = label.id;
          break;
        }
      }

      // If not, create one
      if (!repliedLabelId) {
        const newLabelResponse = await gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name: "Replied",
            labelListVisibility: "labelShow",
            messageListVisibility: "show"
          }
        });
        repliedLabelId = newLabelResponse.data.id;
        console.log(`Created new label with id ${repliedLabelId}`);
      }

      // Get the list of messages
      const messagesResponse = await gmail.users.messages.list({ userId: 'me' });
      const messages = messagesResponse.data.messages;
      console.log(messages);

      // For each message
      for (let message of messages) {
        // Get the message details
        const messageResponse = await gmail.users.messages.get({ userId: 'me', id: message.id });
        const messageData = messageResponse.data;
        console.log(messageData);

        // Check if the message has the "Replied" label
        if (messageData.labelIds.includes(repliedLabelId)) {
          // Skip this message
          console.log(`Message ${message.id} already has the Replied label`);
          continue;
        }

        // Check if the message is a first-time email from someone else
        // We assume this is true if the message has only one threadId and no In-Reply-To header
        const threadId = messageData.threadId;
        const inReplyTo = messageData.payload.headers.find(header => header.name === "In-Reply-To");
        if (messageData.resultSizeEstimate === 1 && !inReplyTo) {
          // Reply to this message
          console.log(`Message ${message.id} is a first-time email from someone else`);
          // Get the sender's email address from the From header
          const from = messageData.payload.headers.find(header => header.name === "From");
          const sender = from.value.match(/<(.*)>/)[1];
          console.log(`Sender's email is ${sender}`);
          // Get the subject from the Subject header
          const subject = messageData.payload.headers.find(header => header.name === "Subject");
          console.log(`Subject is ${subject.value}`);
          // Create a reply message body
          const replyBody = `Hi, thank you for your email. This is an automated reply. Have a nice day!`;
          // Create a raw email string
          const email = [
            `From: me`,
            `To: ${sender}`,
            `Subject: Re: ${subject.value}`,
            `In-Reply-To: ${message.id}`,
            `References: ${message.id}`,
            ``,
            replyBody
          ].join('\r\n');
          // Encode the email string in base64url format
          const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          // Send the email using Gmail API
          const sendResponse = await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
              raw: encodedEmail
            }
          });
          console.log(`Sent reply to ${sender}`);

          // Add the "Replied" label to the message
          const modifyResponse = await gmail.users.messages.modify({
            userId: 'me',
            id: message.id,
            requestBody: {
              addLabelIds: [repliedLabelId]
            }
          });
          console.log(`Added Replied label to message ${message.id}`);
        } else {
          // Do nothing for this message
          console.log(`Message ${message.id} is not a first-time email from someone else`);
        }
      }

      // Send a response to the user with a success message
      res.send('Checked and replied to new emails successfully');

    } catch (error) {
      // Handle any errors
      console.error(error);
      res.status(500).send('Something went wrong');
    }
  } else {
    // User is not logged in, redirect to home page
    res.redirect('/');
  }
});

app.listen(port, () => {
  console.log(`Example app listening at http://localhost:${port}`);
});