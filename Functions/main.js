/**
 * Copyright 2017 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License'); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 * 
 * $ npm install
 * $ zip -r action.zip *
 * $ bx wsk action update alexa-watson action.zip --kind nodejs:6 --web raw --param-file .params
 * 
 * 
 */

'use strict';

const alexaVerifier = require('alexa-verifier');
const ConversationV1 = require('watson-developer-cloud/conversation/v1');
const request = require('request');

// Load the Cloudant library.
var Cloudant = require('@cloudant/cloudant');

function errorResponse(reason) {
  return {
    version: '1.0',
    response: {
      shouldEndSession: true,
      outputSpeech: {
        type: 'PlainText',
        text: reason || 'An unexpected error occurred. Please try again later.'
      }
    }
  };
}

// Using some globals for now
let conversation;
let cloudant;
let alexadb;
let context;
let SkillName;
let MyDirectives = { directives: [  ] };


function unspell(sentence) {
  var isSpelled = /(^|\s)((\S[\s.]){2,})(.$)?/ig;
  var isBlank = /\s/ig;
  var replacedText = sentence.replace(isSpelled, function(m){ return ' ' + m.replace(isBlank,'') + ' '});
  replacedText = replacedText.trim();
  //console.log('<' + sentence + '> -> <' + replacedText + '>');
  return replacedText;
}


function verifyFromAlexa(args, rawBody) {
  return new Promise(function(resolve, reject) {
    const certUrl = args.__ow_headers.signaturecertchainurl;
    const signature = args.__ow_headers.signature;
    console.log("--- VERIFY FROM ALEXA ------------------------------")
    console.log(rawBody.request);
    alexaVerifier(certUrl, signature, rawBody, function(err) {
      if (err) {
        console.error('err? ' + JSON.stringify(err));
        throw new Error('Alexa verification failed.');
      }
      resolve();
    });
  });
}


function initClients(args) {

  SkillName = args.SKILL_NAME;
  
  // Connect a client to Watson Assistant
  conversation = new ConversationV1({
    username: args.CONVERSATION_USERNAME,
    password: args.CONVERSATION_PASSWORD,
    version_date: ConversationV1.VERSION_DATE_2017_04_21
  });
  console.log("-- INIT CLIENT ----------------------------------------------");
  console.log('Connected to Watson Conversation');

  // Connect a client to Cloudant
  if (args.CLOUDANT_DB) {
      // Initialize the library with my account.
      cloudant = Cloudant({account:args.CLOUDANT_ID, password:args.CLOUDANT_PWD});
      // Specify the database we are going to use (alice)...
      alexadb = cloudant.db.use(args.CLOUDANT_DB);
  } else {
    console.log('No Cloudant db available');
  }
  console.log('Connected to Cloudant'); 
}


function getSessionContext(sessionId) {
  console.log("-- GET SESSION CONTEXT ----------------------------------------------");
  console.log('sessionId: ' + sessionId);

  return new Promise(function(resolve, reject) {

    alexadb.find({selector:{_id:sessionId}}, function(err, result) {
        if (err) {
            console.error(err);
            reject('Error getting context from Redis.');
        }
        context = {};
        if (result.docs.length > 0) {
            context = JSON.parse(result.docs[0].ContextString);
        } ;
        //console.log('context:');
        //console.log(context);
        resolve();
    });
    
  });
}



function conversationMessage(request, workspaceId) {
  return new Promise(function(resolve, reject) {
    console.log("-- CALL WATSON ----------------------------------------------");
    console.log("Request received ");
    console.log(request);
    //console.log('WORKSPACE_ID: ' + workspaceId);
    let input = "";
   
    input = request.intent ? request.intent.slots.EveryThingSlot.value : 'start skill';
    if ( typeof input !== 'undefined' && input ) {
        // if Alexa added the skill name at the begining of the input, remove it before sending to Watson
        if (input.substr(0, SkillName.length).toUpperCase() == SkillName.toUpperCase()) {
          console.log("Extract Skill Name");
          input = input.substring(SkillName.length).trim();
        }
          // remove space in word if word was spelled
        input = unspell(input);
    } else {
        input = "";
    }
    console.log('Input text 1: ' + input);
   
    conversation.message(
      {
        input: { text: input },
        workspace_id: workspaceId,
        context: context
      },
      function(err, watsonResponse) {
        if (err) {
          console.error(err);
          reject('Error talking to Watson.');
        } else {
          console.log("watson Response");
          console.log(watsonResponse);
          context = watsonResponse.context; // Update global context
          resolve(watsonResponse);
        }
      }
    );
  });
}


// Functions for Actions  --------------------------------------------------------------------------------------------------

function crtSndAuthenticationCode(args) {
  return new Promise(function(resolve, reject) {

      console.log("-- Create and Send authentication Code  -------------------------------------------");
      // generate new IBM i pasword
      var min = Math.ceil(0);
      var max = Math.floor(9);
      var nb1 = (Math.floor(Math.random() * (max - min +1)) + min).toString();
      var pwd = Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 5) + nb1; 
      context.password = pwd;
      context.password_spelled = " . " + pwd.split('').join(' . ') + " . ";

      // generate an authentication code between 100000 and 999999 for 2FA
      var min = Math.ceil(100000);
      var max = Math.floor(999999);
      context.code = (Math.floor(Math.random() * (max - min +1)) + min).toString();

      // generate SMS content for Free mobile gateway
      context.message = context.message + context.code ;
    
      if (context.send_mod === "sms") {
          // Send Authentication Code using OVH Gateway
          var ovh = require('ovh')({
            endpoint: 'ovh-eu',
            appKey: args.OVH_APP_KEY,
            appSecret: args.OVH_APP_SECRET,
            consumerKey: args.OVH_CONSUMER_KEY
          });

          // Get the serviceName (name of your OVH sms account)
          ovh.request('GET', '/sms', function (err, serviceName) {
            if(err) {
              console.log("Error occured during SMS sending");
              console.log(err, serviceName);
              resolve(false);
            }
            else {
              // Send a simple SMS with a short number using your serviceName
              ovh.request('POST', '/sms/' + serviceName + '/jobs', {
                  message: context.message, // + context.code,
                  sender: 'iHelpdesk',
                  senderForResponse: false,
                  noStopClause: true,
                  receivers: [context.ad_user.telephoneNumber]
              }, function (errsend, result) {
                  console.log("SMS Sent");
                  console.log(errsend, result);
                  resolve(true);
              });
            }
          });  
      } else { 
          // By default, send code by email 
          var sgMail = require('@sendgrid/mail');
          sgMail.setApiKey(args.SENDGRID_APIKEY);
          const msg = {
            to: context.ad_user.mail,
            from: 'helpdesk.chatbot@noreply.com',
            subject: 'iHelpdesk: Authentication code',
            text: context.message ,
            html: '<strong>' + context.message + '</strong>',
          };
          sgMail.send(msg);
          resolve(true);
      }
  });
}


function chgUserProfile(args) {
  return new Promise(function(resolve, reject) {

    const url =  args.iREST_URL + "/userprofile/password" ;
    console.log("-- CHANGE IBM i usrprf parameters -------------------------------------------");
    console.log("Update usrprf " + context.userprf + " password to " + context.password);

    var jsonDataObj = {'usrprf': context.userprf , 'password': context.password};

    request(
      {
        method: 'POST',
        body: jsonDataObj,
        url: url,
        json: true,
      },
      function(err, response, body) {
        if (err) {
          reject('Error changing user profile');
        }

        body = body.toString();
        console.log("Response " + body);
        console.log(body);

        var newrequest = { 
          "type": "IntentRequest",
          "intent": {
            "name": "EveryThingIntent",
            "slots": {
              "EveryThingSlot": {
                "name": "EveryThingSlot",
                "value": body
              }
            }
          }
        };
        resolve(newrequest);
      }
    );
  });
}


function rtvADinfo(args) {
  return new Promise(function(resolve, reject) {
    const url =  args.iREST_URL + "/ad/findUser/" + context.userprf;
    console.log("-- GET AD account parameters for given IBM i account -----------------------------------------");
    console.log("Looking for " + context.userprf + " owner in AD");
    request(
      {
        method: 'GET',
        url: url,
        json: true,
      },
      function(err, response, body) {
        if (err) {
          reject('Error retreiving AD info');
        }
        console.log("Response");
        console.log(body);
        if (Object.keys(body).length > 0) {
            if (body.users.length > 0) {
              context.ad_user = body.users[0];
              resolve(true);
            } else {
                resolve(false);
            }
        } else {
          resolve(false);
        }
      }
    );
  });
}


function dspUserProfile(userExist, args, ressourceType) {
  return new Promise(function(resolve, reject) {
    if (userExist) {
        const url =  args.iREST_URL + "/userprofile/status/" + context.userprf;
        console.log("-- GET IBM i usrprf parameters -------------------------------------------");
        console.log("Looking for " + context.userprf + " parameters");
        request(
          {
            method: 'GET',
            url: url,
            json: true,
          },
          function(err, response, body) {
            if (err) {
              reject('Error retreiving user profile');
            }
            console.log("Response");
            console.log(body);
            
            if ( (body != 204) && (body != 500) ) {
              if (body.STATUS == "*DISABLED") body = "DISABLED (" + body.SIGN_ON_ATTEMPTS_NOT_VALID + ")";
              else if (body.NO_PASSWORD_INDICATOR == "YES") body = "NO_PASSWORD" 
                  else if (body.SET_PASSWORD_TO_EXPIRE == "YES")  body = "PASSWORD_EXPIRED";
                        else body = "200";
            } ;
            body = body.toString();
            console.log("IBM i usrprf status: " + body);

            var newrequest = { 
              "type": "IntentRequest",
              "intent": {
                "name": "EveryThingIntent",
                "slots": {
                  "EveryThingSlot": {
                    "name": "EveryThingSlot",
                    "value": body
                  }
                }
              }
            };
            resolve(newrequest);
          }
        );
    } else {
        console.log("No AD account, don't have to query IBM i");

        var newrequest = { 
          "type": "IntentRequest",
          "intent": {
            "name": "EveryThingIntent",
            "slots": {
              "EveryThingSlot": {
                "name": "EveryThingSlot",
                "value": "204"
              }
            }
          }
        };
        resolve(newrequest);
    }
  });
}


function lookupIBMiResource(args, ressourceType) {
  if (args.iREST_URL) {
    return new Promise(function(resolve, reject) {
  
      const url = args.iREST_URL + "/system/" + ressourceType.toLowerCase();

      console.log("-- GET IBM i ressource level -------------------------------------------");
      console.log('Getting level for ' + ressourceType);
      request(
        {
          method: 'GET',
          url: url,
          json: true,
        },
        function(err, response, body) {
          if (err) {
            reject('Resource Level not found');
          }
          console.log("Response");
          console.log(body);
          console.log("resource type = " + ressourceType);  
          console.log("resource value before = " + body.ELAPSED_CPU_USED); 
          var resourceValue = 0;
          switch (ressourceType.toLowerCase()) {
            case "cpu": resourceValue = isNaN(body.ELAPSED_CPU_USED) ? "unknown" : body.ELAPSED_CPU_USED; break;
            case "asp" : resourceValue = isNaN(body.SYSTEM_ASP_USED) ? "unknown" : body.SYSTEM_ASP_USED; break;
            case "age" : resourceValue = isNaN(body.AGE) ? "unknown" : body.AGE ; break;
            default : console.log("no ressource type defined");
          }
          console.log("resource value = " + resourceValue);        
          var newrequest = { 
            "type": "IntentRequest",
            "intent": {
              "name": "EveryThingIntent",
              "slots": {
                "EveryThingSlot": {
                  "name": "EveryThingSlot",
                  "value": resourceValue
                }
              }
            }
           }
          console.log(newrequest);
          resolve(newrequest);
        }
      );
    });
  } else {
    console.log('Cannot lookup resource from IBM i (no URL provides');
    var newrequest = { 
      "type": "IntentRequest",
      "intent": {
        "name": "EveryThingIntent",
        "slots": {
          "EveryThingSlot": {
            "name": "EveryThingSlot",
            "value": "unknown"
          }
        }
      }
     }
    return Promise.resolve(newrequest);
  }
}


// End : Actions funtions --------------------------------------------------------------------------------------------------

function actionHandler(args, watsonResponse) {
  return new Promise((resolve, reject) => {
    console.log("-- ACTION HANDLER ----------------------------------------------");
    console.log('Begin actionHandler');
    //console.log(args);
    console.log(watsonResponse);
    switch (watsonResponse.context.ACTION) {

     case "AGE":
          console.log("Action retrieve AGE requested");
          return lookupIBMiResource(args, "age") 
           .then(newRequest => conversationMessage(newRequest, args.WORKSPACE_ID))
           .then(watsonResponse => {
                console.log("end of retrieve AGE action")
                console.log("add music file to response");
                MyDirectives = {
                    directives: [
                      {
                        type: "AudioPlayer.Play",
                        playBehavior: "REPLACE_ALL",
                        audioItem: {
                          stream: {
                            token: "xtofsingbirthday",
                            url: "https://ibm.box.com/shared/static/0rsh0jbv1kpx60t70kofb9ih0ppohbcw.mp3",
                            offsetInMilliseconds: 0
                          }
                        }
                      }
                    ]
                };
                resolve(watsonResponse);
           });
           break; 

      case "CPU":
          console.log("Action retrieve CPU requested");
          return lookupIBMiResource(args, "cpu") 
           .then(newRequest => conversationMessage(newRequest, args.WORKSPACE_ID))
           .then(watsonResponse => {
                console.log("end of retrieve CPU action");
                MyDirectives = { directives: [  ] };
                resolve(watsonResponse);
           });
           break;
          
      case "ASP":
          console.log("Action retrieve ASP requested");
          return lookupIBMiResource(args, "asp") 
          .then(newRequest => conversationMessage(newRequest, args.WORKSPACE_ID))
          .then(watsonResponse => {
               console.log("end of retrieve ASP action");
               resolve(watsonResponse);
          });
          break;

      case "Query_user":
          console.log("Action retrieve user profile attributes");
          return rtvADinfo(args)
          .then(userExist => dspUserProfile(userExist, args, "asp"))
          .then(newRequest => conversationMessage(newRequest, args.WORKSPACE_ID))
          .then(watsonResponse => {
               console.log("end of Query_user action");
               MyDirectives = { directives: [  ] };
               resolve(watsonResponse);
          });
          break;

      case "Change_password":
          console.log("Action Change user profile attributes");
          return chgUserProfile(args)
          .then(newRequest => conversationMessage(newRequest, args.WORKSPACE_ID))
          .then(watsonResponse => {
               console.log("end of Change_password action");
               MyDirectives = { directives: [  ] };
               resolve(watsonResponse);
          });
          break;

      case "Send_code":
          console.log("Action Create and Send authentication Code");
          return crtSndAuthenticationCode(args) 
          .then(() => {
               MyDirectives = { directives: [  ] };
               resolve(watsonResponse);
          });
          break;

      default:
        // No action. Resolve with watsonResponse as-is.
        console.log('No action');
        MyDirectives = { directives: [  ] };
        return resolve(watsonResponse);
    }
  });
}


function sendResponse(response, resolve) {
  console.log("-- SEND RESPONSE ----------------------------------------------");
  console.log('Begin sendResponse');
  console.log(response);

  // Combine the output messages into one message.
  const output = response.output.text.join(' ');
  console.log('Output text: ' + output);

  // Resolve the main promise now that we have our response
  resolve({
    version: '1.0',
    response: {
      shouldEndSession: false,
      outputSpeech: {
        type: 'PlainText',
        text: output
      },
      reprompt: {
        outputSpeech: {
          type: 'PlainText',
          text: ''
        }
      },
      directives: MyDirectives.directives
    }
  });
}


function saveSessionContext(sessionId) {
  console.log("-- SAVE CONTEXT ----------------------------------------------");
  console.log('Begin saveSessionContext 2');
  console.log(sessionId);

    // Save the context in Cloudant. Can do this after resolve(response).
    if (context) {
      alexadb.find({selector:{_id:sessionId}}, function(err, result) {

          if (err) {
              console.error(err);
              reject('Error getting context from Cloudant.');
          }
      
          if (result.docs.length >0) {  // sessionId record is already in DB: update
              result.docs[0].c = true;
              result.docs[0].ContextString =  JSON.stringify(context);
              console.log("New Context");
              //console.log(result.docs[0].ContextString );
              alexadb.insert(result.docs[0], function(err, data) {
                  if (err) {
                    console.error(err);
                    reject('Error setting new context from Cloudant.');
                  } 
                  console.log('Saved new context in Cloudant for existing ' + sessionId);
                  //console.log('Error:', err);
                  //console.log('Data:', data);        
              });
          } else { // sessionId record is already in DB : create a new one
              alexadb.insert({ "_id": sessionId, "ContextString": JSON.stringify(context) }, function(err, data) {
                  console.log('Saved new context in Cloudant for new ' + sessionId);
                  //console.log('Error:', err);
                  //console.log('Data:', data); 
              });
          }
      
      });
  } else {
    console.log("No context to ba saved");
  }

}



function main(args) {
  console.log('Begin action');
  // console.log(args);
  return new Promise(function(resolve, reject) {
    if (!args.__ow_body) {
      return reject(errorResponse('Must be called from Alexa.'));
    }

    const rawBody = Buffer.from(args.__ow_body, 'base64').toString('ascii');
    const body = JSON.parse(rawBody);

    if (typeof body.session.user === 'undefined' || body.session.user === null) {
      console.log("Amazon user not defined");
    } else {
      const sessionId = body.session.user.userId; //  body.session.sessionId;
      const request = body.request;

      verifyFromAlexa(args, rawBody)
      .then(() => initClients(args))
      .then(() => getSessionContext(sessionId))
      .then(() => conversationMessage(request, args.WORKSPACE_ID))
      .then(watsonResponse => actionHandler(args, watsonResponse))
      .then(actionResponse => sendResponse(actionResponse, resolve))
      .then(() => saveSessionContext(sessionId))
      .catch(err => {
        console.error('Caught error: ');
        console.log(err);
        reject(errorResponse(err));
      });
    }
  });
}

exports.main = main;
