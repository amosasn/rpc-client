/*
 * js_channel is a very lightweight abstraction on top of
 * postMessage which defines message formats and semantics
 * to support interactions more rich than just message passing
 * js_channel supports:
 *  + query/response - traditional rpc
 *  + query/update/response - incremental async return of results
 *    to a query
 *  + notifications - fire and forget
 *  + error handling
 *
 * js_channel is based heavily on json-rpc, but is focused at the
 * problem of inter-iframe RPC.
 *
 * Message types:
 *  There are 5 types of messages that can flow over this channel,
 *  and you may determine what type of message an object is by
 *  examining its parameters:
 *  1. Requests
 *    + integer id
 *    + string method
 *    + (optional) any params
 *  2. Callback Invocations (or just "Callbacks")
 *    + integer id
 *    + string callback
 *    + (optional) params
 *  3. Error Responses (or just "Errors)
 *    + integer id
 *    + string error
 *    + (optional) string message
 *  4. Responses
 *    + integer id
 *    + (optional) any result
 *  5. Notifications
 *    + string method
 *    + (optional) any params
 */

// Universal module definition //
(function (root, factory) {
  if (typeof exports === 'object') {
    // CommonJS
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define([], function () {
      return (root.Channel = factory());
    });
  } else {
    // Global Variables
    root.Channel = factory();
  }
}(this, function () {
  "use strict";
  var Channel = (function() {

    // current transaction id, start out at a random *odd* number between 1 and a million
    // There is one current transaction counter id per page, and it's shared between
    // channel instances.  That means of all messages posted from a single javascript
    // evaluation context, we'll never have two with the same id.
    var s_curTranId = Math.floor(Math.random()*1000001);

    // no two bound channels in the same javascript evaluation context may have the same origin, scope, and window.
    // further if two bound channels have the same window and scope, they may not have *overlapping* origins
    // (either one or both support '*').  This restriction allows a single onMessage handler to efficiently
    // route messages based on origin and scope.  The s_boundChans maps origins to scopes, to message
    // handlers.  Request and Notification messages are routed using this table.
    // Finally, channels are inserted into this table when built, and removed when destroyed.
    var s_boundChans = { };

    // add a channel to s_boundChans, throwing if a dup exists
    function s_addBoundChan(win, origin, scope, handler) {
        function hasWin(arr) {
            for (var i = 0; i < arr.length; i++) if (arr[i].win === win) return true;
            return false;
        }

        // does she exist?
        var exists = false;

        if (origin === '*') {
            // we must check all other origins, sadly.
            for (var k in s_boundChans) {
                if (!s_boundChans.hasOwnProperty(k)) continue;
                if (k === '*') continue;
                if (typeof s_boundChans[k][scope] === 'object') {
                    exists = hasWin(s_boundChans[k][scope]);
                    if (exists) break;
                }
            }
        } else {
            // we must check only '*'
            if ((s_boundChans['*'] && s_boundChans['*'][scope])) {
                exists = hasWin(s_boundChans['*'][scope]);
            }
            if (!exists && s_boundChans[origin] && s_boundChans[origin][scope])
            {
                exists = hasWin(s_boundChans[origin][scope]);
            }
        }
        if (exists) throw "A channel is already bound to the same window which overlaps with origin '"+ origin +"' and has scope '"+scope+"'";

        if (typeof s_boundChans[origin] != 'object') s_boundChans[origin] = { };
        if (typeof s_boundChans[origin][scope] != 'object') s_boundChans[origin][scope] = [ ];
        s_boundChans[origin][scope].push({win: win, handler: handler});
    }

    function s_removeBoundChan(win, origin, scope) {
        var arr = s_boundChans[origin][scope];
        for (var i = 0; i < arr.length; i++) {
            if (arr[i].win === win) {
                arr.splice(i,1);
            }
        }
        if (s_boundChans[origin][scope].length === 0) {
            delete s_boundChans[origin][scope];
        }
    }

    function s_isArray(obj) {
        if (Array.isArray) return Array.isArray(obj);
        else {
            return (obj.constructor.toString().indexOf("Array") != -1);
        }
    }

    // No two outstanding outbound messages may have the same id, period.  Given that, a single table
    // mapping "transaction ids" to message handlers, allows efficient routing of Callback, Error, and
    // Response messages.  Entries are added to this table when requests are sent, and removed when
    // responses are received.
    var s_transIds = { };

    // class singleton onMessage handler
    // this function is registered once and all incoming messages route through here.  This
    // arrangement allows certain efficiencies, message data is only parsed once and dispatch
    // is more efficient, especially for large numbers of simultaneous channels.
    var s_onMessage = function(e) {
        try {
          var m = JSON.parse(e.data);
          if (typeof m !== 'object' || m === null) throw "malformed";
        } catch(e) {
          // just ignore any posted messages that do not consist of valid JSON
          return;
        }

        var w = e.source;
        var o = e.origin;
        var s, i, meth;

        if (typeof m.method === 'string') {
            var ar = m.method.split('::');
            if (ar.length == 2) {
                s = ar[0];
                meth = ar[1];
            } else {
                meth = m.method;
            }
        }

        if (typeof m.id !== 'undefined') i = m.id;

        // w is message source window
        // o is message origin
        // m is parsed message
        // s is message scope
        // i is message id (or undefined)
        // meth is unscoped method name
        // ^^ based on these factors we can route the message

        // if it has a method it's either a notification or a request,
        // route using s_boundChans
        if (typeof meth === 'string') {
            var delivered = false;
            if (s_boundChans[o] && s_boundChans[o][s]) {
                for (var j = 0; j < s_boundChans[o][s].length; j++) {
                    if (s_boundChans[o][s][j].win === w) {
                        s_boundChans[o][s][j].handler(o, meth, m);
                        delivered = true;
                        break;
                    }
                }
            }

            if (!delivered && s_boundChans['*'] && s_boundChans['*'][s]) {
                for (var j = 0; j < s_boundChans['*'][s].length; j++) {
                    if (s_boundChans['*'][s][j].win === w) {
                        s_boundChans['*'][s][j].handler(o, meth, m);
                        break;
                    }
                }
            }
        }
        // otherwise it must have an id (or be poorly formed
        else if (typeof i != 'undefined') {
            if (s_transIds[i]) s_transIds[i](o, meth, m);
        }
    };

    // Setup postMessage event listeners
    if (window.addEventListener) window.addEventListener('message', s_onMessage, false);
    else if(window.attachEvent) window.attachEvent('onmessage', s_onMessage);

    /* a messaging channel is constructed from a window and an origin.
     * the channel will assert that all messages received over the
     * channel match the origin
     *
     * Arguments to Channel.build(cfg):
     *
     *   cfg.window - the remote window with which we'll communicate
     *   cfg.origin - the expected origin of the remote window, may be '*'
     *                which matches any origin
     *   cfg.scope  - the 'scope' of messages.  a scope string that is
     *                prepended to message names.  local and remote endpoints
     *                of a single channel must agree upon scope. Scope may
     *                not contain double colons ('::').
     *   cfg.debugOutput - A boolean value.  If true and window.console.log is
     *                a function, then debug strings will be emitted to that
     *                function.
     *   cfg.postMessageObserver - A function that will be passed two arguments,
     *                an origin and a message.  It will be passed these immediately
     *                before messages are posted.
     *   cfg.gotMessageObserver - A function that will be passed two arguments,
     *                an origin and a message.  It will be passed these arguments
     *                immediately after they pass scope and origin checks, but before
     *                they are processed.
     *   cfg.onReady - A function that will be invoked when a channel becomes "ready",
     *                this occurs once both sides of the channel have been
     *                instantiated and an application level handshake is exchanged.
     *                the onReady function will be passed a single argument which is
     *                the channel object that was returned from build().
     *   cfg.reconnect - A boolean value - if true, the channel allows reconnection
     *                useful when the page in a child frame is reloaded and wants
     *                to re-establish connection with parent window using the same
     *                origin, scope and bindings.
     *   cfg.publish - A boolean value. If true, bind will automatically publish
     *                the method on the remote side. The method will be published under
     *                channelObject.remote, but it will not be available before the onReady
     *                callback is called on the other side.
     *   cfg.remote - An array of method names for which stubs should be generated without
     *                waiting for remote end to publish them. A string (for a single method name)
     *                is also accepted. This allows methods under channelObject.remote to be called
     *                also before onReady callback is called; the invocations will be queued until
     *                the channel is ready. If the methods do not exist on remote side, the
     *                error callback will be called.
     */
    return {
        build: function(cfg) {
            var debug = function(m) {
                if (cfg.debugOutput && window.console && window.console.log) {
                    // try to stringify, if it doesn't work we'll let javascript's built in toString do its magic
                    try {
                        if (typeof m !== 'string') {
                            m = JSON.stringify(m);
                        }
                    }
                    catch(e) {
                    }
                    window.console.log("["+chanId+"] " + m);
                }
            };

            /* browser capabilities check */
            if (!window.postMessage) throw("jschannel cannot run this browser, no postMessage");
            if (!window.JSON || !window.JSON.stringify || ! window.JSON.parse) {
                throw("jschannel cannot run this browser, no JSON parsing/serialization");
            }

            /* basic argument validation */
            if (typeof cfg != 'object') throw("Channel build invoked without a proper object argument");

            if (!cfg.window || !cfg.window.postMessage) throw("Channel.build() called without a valid window argument");

            /* we'd have to do a little more work to be able to run multiple channels that intercommunicate the same
             * window...  Not sure if we care to support that */
            if (window === cfg.window) throw("target window is same as present window -- not allowed");

            // let's require that the client specify an origin.  if we just assume '*' we'll be
            // propagating unsafe practices.  that would be lame.
            var validOrigin = false;
            if (typeof cfg.origin === 'string') {
                var oMatch;
                if (cfg.origin === "*") validOrigin = true;
                // allow valid domains under http and https.  Also, trim paths off otherwise valid origins.
                else if (null !== (oMatch = cfg.origin.match(/^https?:\/\/(?:[-a-zA-Z0-9_\.])+(?::\d+)?/))) {
                    cfg.origin = oMatch[0].toLowerCase();
                    validOrigin = true;
                }
            }

            if (!validOrigin) throw ("Channel.build() called with an invalid origin");

            if (typeof cfg.scope !== 'undefined') {
                if (typeof cfg.scope !== 'string') throw 'scope, when specified, must be a string';
                if (cfg.scope.split('::').length > 1) throw "scope may not contain double colons: '::'";
            } else {
                cfg.scope = "__default";
            }

            /* private variables */
            // generate a random and psuedo unique id for this channel
            var chanId = (function () {
                var text = "";
                var alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
                for(var i=0; i < 5; i++) text += alpha.charAt(Math.floor(Math.random() * alpha.length));
                return text;
            })();

            // registrations: mapping method names to call objects
            var regTbl = { };
            // current oustanding sent requests
            var outTbl = { };
            // current oustanding received requests
            var inTbl = { };
            // are we ready yet?  when false we will block outbound messages.
            var ready = false;
            var pendingQueue = [ ];
            var publishQueue = [ ];

            var createTransaction = function(id,origin,callbacks) {
                var shouldDelayReturn = false;
                var completed = false;

                return {
                    origin: origin,
                    invoke: function(cbName, v) {
                        // verify in table
                        if (!inTbl[id]) throw "attempting to invoke a callback of a nonexistent transaction: " + id;
                        // verify that the callback name is valid
                        var valid = false;
                        for (var i = 0; i < callbacks.length; i++) if (cbName === callbacks[i]) { valid = true; break; }
                        if (!valid) throw "request supports no such callback '" + cbName + "'";

                        // send callback invocation
                        postMessage({ id: id, callback: cbName, params: v});
                    },
                    error: function(error, message) {
                        completed = true;
                        // verify in table
                        if (!inTbl[id]) throw "error called for nonexistent message: " + id;

                        // remove transaction from table
                        delete inTbl[id];

                        // send error
                        postMessage({ id: id, error: error, message: message });
                    },
                    complete: function(v) {
                        completed = true;
                        // verify in table
                        if (!inTbl[id]) throw "complete called for nonexistent message: " + id;
                        // remove transaction from table
                        delete inTbl[id];
                        // send complete
                        postMessage({ id: id, result: v });
                    },
                    delayReturn: function(delay) {
                        if (typeof delay === 'boolean') {
                            shouldDelayReturn = (delay === true);
                        }
                        return shouldDelayReturn;
                    },
                    completed: function() {
                        return completed;
                    }
                };
            };

            var setTransactionTimeout = function(transId, timeout, method) {
              return window.setTimeout(function() {
                if (outTbl[transId]) {
                  // XXX: what if client code raises an exception here?
                  var msg = "timeout (" + timeout + "ms) exceeded on method '" + method + "'";
                  if (outTbl[transId].error) {
                      outTbl[transId].error("timeout_error", msg);
                  }
                  delete outTbl[transId];
                  delete s_transIds[transId];
                }
              }, timeout);
            };

            var onMessage = function(origin, method, m) {
                // if an observer was specified at allocation time, invoke it
                if (typeof cfg.gotMessageObserver === 'function') {
                    // pass observer a clone of the object so that our
                    // manipulations are not visible (i.e. method unscoping).
                    // This is not particularly efficient, but then we expect
                    // that message observers are primarily for debugging anyway.
                    try {
                        cfg.gotMessageObserver(origin, m);
                    } catch (e) {
                        debug("gotMessageObserver() raised an exception: " + e.toString());
                    }
                }

                // now, what type of message is this?
                if (m.id && method) {
                    inTbl[m.id] = { };
                    var trans = createTransaction(m.id, origin, m.callbacks ? m.callbacks : [ ]);
                    // a request!  do we have a registered handler for this request?
                    if (regTbl[method]) {
                        try {
                            // callback handling.  we'll magically create functions inside the parameter list for each
                            // callback
                            if (m.callbacks && s_isArray(m.callbacks) && m.callbacks.length > 0) {
                                for (var i = 0; i < m.callbacks.length; i++) {
                                    var path = m.callbacks[i];
                                    var obj = m.params;
                                    var pathItems = path.split('/');
                                    for (var j = 0; j < pathItems.length - 1; j++) {
                                        var cp = pathItems[j];
                                        if (typeof obj[cp] !== 'object') obj[cp] = { };
                                        obj = obj[cp];
                                    }
                                    obj[pathItems[pathItems.length - 1]] = (function() {
                                        var cbName = path;
                                        return function(params) {
                                            return trans.invoke(cbName, params);
                                        };
                                    })();
                                }
                            }
                            var resp = regTbl[method](trans, m.params);
                            if (!trans.delayReturn() && !trans.completed()) trans.complete(resp);
                        } catch(e) {
                            // automagic handling of exceptions:
                            var error = "runtime_error";
                            var message = null;
                            // * if it's a string then it gets an error code of 'runtime_error' and string is the message
                            if (typeof e === 'string') {
                                message = e;
                            } else if (typeof e === 'object') {
                                // if it's an Error instance we use the constructor name to set the error property
                                // and we just copy the error message
                                if (e instanceof Error) {
                                    error = e.constructor.name;
                                    message = e.message;
                                }
                                // Otherwise, it's either an array or an object
                                // * if it's an array of length two, then  array[0] is the code, array[1] is the error message
                                else if (e && s_isArray(e) && e.length == 2) {
                                    error = e[0];
                                    message = e[1];
                                }
                                // * if it's an object then we'll look form error and message parameters
                                else if (typeof e.error === 'string') {
                                    error = e.error;
                                    if (!e.message) message = "";
                                    else if (typeof e.message === 'string') message = e.message;
                                    else e = e.message; // let the stringify/toString message give us a reasonable verbose error string
                                }
                            }

                            // message is *still* null, let's try harder
                            if (message === null) {
                                try {
                                    message = JSON.stringify(e);
                                    /* On MSIE8, this can result in 'out of memory', which
                                     * leaves message undefined. */
                                    if (typeof(message) == 'undefined')
                                      message = e.toString();
                                } catch (e2) {
                                    message = e.toString();
                                }
                            }

                            trans.error(error,message);
                        }
                    } else { // if no method found, send error
                        trans.error("method_not_found", "No method '" + method + "' was (yet) bound by the provider");
                    }
                } else if (m.id && m.callback) {
                    if (!outTbl[m.id] ||!outTbl[m.id].callbacks || !outTbl[m.id].callbacks[m.callback])
                    {
                        debug("ignoring invalid callback, id:"+m.id+ " (" + m.callback +")");
                    } else {
                        // XXX: what if client code raises an exception here?
                        outTbl[m.id].callbacks[m.callback](m.params);
                    }
                } else if (m.id) {
                    if (!outTbl[m.id]) {
                        debug("ignoring invalid response: " + m.id);
                    } else {
                        // XXX: what if client code raises an exception here?
                        if (m.error) {
                            // We might not have an error callback
                            if(outTbl[m.id].error) {
                                outTbl[m.id].error(m.error, m.message);
                            }
                        } else {
                            // But we always have a success callback
                            if (m.result !== undefined) {
                                outTbl[m.id].success(m.result);
                            } else {
                                outTbl[m.id].success();
                            }
                        }
                        delete outTbl[m.id];
                        delete s_transIds[m.id];
                    }
                } else if (method) {
                    // tis a notification.
                    if (regTbl[method]) {
                        // yep, there's a handler for that.
                        // transaction has only origin for notifications.
                        regTbl[method]({ origin: origin }, m.params);
                        // if the client throws, we'll just let it bubble out
                        // what can we do?  Also, here we'll ignore return values
                    }
                }
            };

            // now register our bound channel for msg routing
            s_addBoundChan(cfg.window, cfg.origin, cfg.scope, onMessage);

            // scope method names based on cfg.scope specified when the Channel was instantiated
            var scopeMethod = function(m) {
                return [cfg.scope, m].join("::");
            };

            // a small wrapper around postmessage whose primary function is to handle the
            // case that clients start sending messages before the other end is "ready"
            var postMessage = function(msg, force) {
                if (!msg) throw "postMessage called with null message";

                // delay posting if we're not ready yet.
                if (!force && !ready) {
                    debug("queue message: " + JSON.stringify(msg));
                    pendingQueue.push(msg);
                } else {
                    if (typeof cfg.postMessageObserver === 'function') {
                        try {
                            cfg.postMessageObserver(cfg.origin, msg);
                        } catch (e) {
                            debug("postMessageObserver() raised an exception: " + e.toString());
                        }
                    }
                    debug("post message: " + JSON.stringify(msg) + " with origin " + cfg.origin);
                    cfg.window.postMessage(JSON.stringify(msg), cfg.origin);
                }
            };

            var onReady = function(trans, params) {
                debug('ready msg received');
                if (ready && !cfg.reconnect) {
                    throw "received ready message while in ready state.";
                }
                ready = true;

                // only append suffix to chanId once:
                if (chanId.length < 6) {
	                if (params.type === 'publish-request') {
	                    chanId += '-R';
	                } else {
	                    chanId += '-L';
	                }
                }
                debug('ready msg accepted.');

                if (params.type === 'publish-request') {
                    obj.notify({ method: '__ready', params: {
                        type:'publish-reply',
                        publish: publishQueue
                    } });
                }

                for (var i = 0; i < params.publish.length; i++) {
                    if (params.publish[i].action === "bind") {
                        createStubs([params.publish[i].method], obj.remote);
                    } else { // unbind
                        delete obj.remote[params.publish[i].method];
                    }
                }

                //unbind ready handler unless we allow reconnecting:
                if (!cfg.reconnect) {
                    obj.unbind('__ready', true); // now this handler isn't needed any more.
                }

                // flush queue
                while (pendingQueue.length) {
                    postMessage(pendingQueue.splice(0, 1)[0]);
                }
                publishQueue = [];
                // invoke onReady observer if provided
                if (typeof cfg.onReady === 'function') cfg.onReady(obj);

            };

            var createStubs = function(stubList, targetObj) {
                stubList = [].concat(stubList); // Coerce into array, allows string to be used for single-item array
                var method;
                for(var i=0; i < stubList.length; i++) {
                    method = stubList[i].toString();
                    targetObj[method] = function(m) {
                        return function(params, success, error) {
                            if (success) {
                                obj.call({
                                    method: m,
                                    params: params,
                                    success: success,
                                    error: error
                                });
                            } else {
                                obj.notify({
                                    method: m,
                                    params: params
                                });
                            }
                        };
                    }(method);
                }
            }

            // Dynamic publish from remote
            var onBind = function(trans, method) {
                createStubs([method], obj.remote);
            };

            // Dynamic unpublish from remote
            var onUnbind = function(trans, method) {
                if (obj.remote[method]) {
                    delete obj.remote[method];
                }
            };

            var obj = {

                remote: {},

                // tries to unbind a bound message handler.  returns false if not possible
                unbind: function (method, doNotPublish) {
                    if (regTbl[method]) {
                        if (!(delete regTbl[method])) throw ("can't delete method: " + method);
                        if (cfg.publish && ! doNotPublish) {
                            if (ready) {
                                obj.notify({ method: '__unbind', params: method });
                            } else {
                                publishQueue.push({ action: 'unbind', method: method });
                            }
                        }
                        return true;
                    }
                    return false;
                },
                bind: function (method, cb, doNotPublish) {
                    if (!method || typeof method !== 'string') throw "'method' argument to bind must be string";
                    if (!cb || typeof cb !== 'function') throw "callback missing from bind params";

                    if (regTbl[method]) throw "method '"+method+"' is already bound!";
                    regTbl[method] = cb;
                    if (cfg.publish && ! doNotPublish) {
                        if (ready) {
                            obj.notify({ method: '__bind', params: method });
                        } else {
                            publishQueue.push({ action: 'bind', method: method });
                        }
                    }
                    return this;
                },
                call: function(m) {
                    if (!m) throw 'missing arguments to call function';
                    if (!m.method || typeof m.method !== 'string') throw "'method' argument to call must be string";
                    if (!m.success || typeof m.success !== 'function') throw "'success' callback missing from call";

                    // now it's time to support the 'callback' feature of jschannel.  We'll traverse the argument
                    // object and pick out all of the functions that were passed as arguments.
                    var callbacks = { };
                    var callbackNames = [ ];
                    var seen = [ ];

                    var pruneFunctions = function (path, obj) {
                        if (seen.indexOf(obj) >= 0) {
                            throw "params cannot be a recursive data structure"
                        }
                        if(obj) {
                            seen.push(obj);
                        }

                        if (typeof obj === 'object') {
                            for (var k in obj) {
                                if (!obj.hasOwnProperty(k)) continue;
                                var np = path + (path.length ? '/' : '') + k;
                                if (typeof obj[k] === 'function') {
                                    callbacks[np] = obj[k];
                                    callbackNames.push(np);
                                    delete obj[k];
                                } else if (typeof obj[k] === 'object') {
                                    pruneFunctions(np, obj[k]);
                                }
                            }
                        }
                    };
                    pruneFunctions("", m.params);

                    // build a 'request' message and send it
                    var msg = { id: s_curTranId, method: scopeMethod(m.method), params: m.params };
                    if (callbackNames.length) msg.callbacks = callbackNames;

                    if (m.timeout)
                      // XXX: This function returns a timeout ID, but we don't do anything with it.
                      // We might want to keep track of it so we can cancel it using clearTimeout()
                      // when the transaction completes.
                      setTransactionTimeout(s_curTranId, m.timeout, scopeMethod(m.method));

                    // insert into the transaction table
                    outTbl[s_curTranId] = { callbacks: callbacks, error: m.error, success: m.success };
                    s_transIds[s_curTranId] = onMessage;

                    // increment current id
                    s_curTranId++;

                    postMessage(msg);
                },
                notify: function(m) {
                    if (!m) throw 'missing arguments to notify function';
                    if (!m.method || typeof m.method !== 'string') throw "'method' argument to notify must be string";

                    // no need to go into any transaction table
                    postMessage({ method: scopeMethod(m.method), params: m.params });
                },
                destroy: function () {
                    s_removeBoundChan(cfg.window, cfg.origin, cfg.scope);
                    if (window.removeEventListener) window.removeEventListener('message', onMessage, false);
                    else if(window.detachEvent) window.detachEvent('onmessage', onMessage);
                    ready = false;
                    regTbl = { };
                    inTbl = { };
                    outTbl = { };
                    cfg.origin = null;
                    pendingQueue = [ ];
                    debug("channel destroyed");
                    chanId = "";
                }
            };

            obj.bind('__ready', onReady, true);
            obj.bind('__bind', onBind, true);
            obj.bind('__unbind', onUnbind, true);
            if (cfg.remote) {
                createStubs(cfg.remote, obj.remote);
            }
            setTimeout(function() {
                if (chanId.length > 0) { // The channel might already have been destroyed
                    postMessage({ method: scopeMethod('__ready'), params: {
                        type: "publish-request",
                        publish: publishQueue
                    } }, true);
                }

            }, 0);

            return obj;
        }
    };
  })();


  return Channel;
}));

/**
 * Oskari RPC client
 * Version: 2.0.4
 */
(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(['jschannel'], factory);
    } else if (typeof module === 'object' && module.exports) {
        // Node. Does not work with strict CommonJS, but
        // only CommonJS-like environments that support module.exports,
        // like Node.
        module.exports = factory(require('jschannel'));
    } else {
        // Browser globals (root is window)
        root.OskariRPC = factory(root.Channel);
    }
}(this, function (JSChannel) {

    'use strict';
    var rpcClientVersion = '2.0.4';
    return {
        VERSION: rpcClientVersion,
        connect: function (target, origin) {
            if (JSChannel === null || JSChannel === undefined) {
                throw new Error('JSChannel not found.');
            }

            if (target === null || target === undefined) {
                throw new TypeError('Missing target element.');
            }

            if (!target.contentWindow) {
                throw new TypeError('Target is missing contentWindow.');
            }

            if (origin === null || origin === undefined) {
                throw new TypeError('Missing origin.');
            }

            if (origin.indexOf('http') !== 0) {
                throw new TypeError('Invalid origin: ' + origin + '.');
            }

            var ready = false;
            var readyCallbacks = [];
            var isDebug = false;
            var RPC_API = {};

            /**
             * API
             * @param  {[type]} blnEnabled [description]
             * @return {[type]}            [description]
             */
            RPC_API.enableDebug = function (blnEnabled) {
                isDebug = !!blnEnabled;
            };

            RPC_API.log = function () {
                if (window.console && window.console.log) {
                    window.console.log.apply(window.console, arguments);
                }
            };

            var defaultErrorHandler = function () {
                RPC_API.log('Error', arguments);
                throw new Error('RPC call failed!');
            };

            RPC_API.isReady = function () {
                return ready;
            };

            RPC_API.onReady = function (cb) {
                if (typeof cb !== 'function') {
                    // not a function
                    return;
                }

                if (ready) {
                    // if ready before adding the listener
                    // -> don't store reference/trigger callback immediately
                    cb();
                } else {
                    // otherwise save reference so we can call it when done
                    readyCallbacks.push(cb);
                }
            };

            RPC_API.destroy = function () {
                channel.destroy();
            };

            var eventHandlers = {};
            /**
             * @public @method handleEvent
             *
             * @param {string}   eventName   Event name
             * @param {function} success Callback function
             */
            RPC_API.handleEvent = function (eventName, handler) {
                if (!eventName) {
                    throw new Error('Event name not specified');
                }

                if (typeof handler !== 'function') {
                    throw new Error('Handler is not a function');
                }

                if (!eventHandlers[eventName]) {
                    eventHandlers[eventName] = [];
                }

                eventHandlers[eventName].push(handler);
                if (eventHandlers[eventName].length !== 1) {
                    // not the first one so we are already listening to the event
                    return;
                }

                // first one, bind listening to it
                channel.bind(eventName, function (trans, data) {
                    // loop eventHandlers[eventName] and call handlers
                    var handlers = eventHandlers[eventName];
                    for (var i = 0; i < handlers.length; ++i) {
                        handlers[i](data);
                    }
                });

                // Listen to event
                channel.call({
                    method: 'handleEvent',
                    params: [eventName, true],
                    success: function () { return undefined; },

                    error: defaultErrorHandler
                });
            };

            RPC_API.unregisterEventHandler = function (eventName, handler) {
                if (!eventName) {
                    throw new Error('Event name not specified');
                }

                var handlers = eventHandlers[eventName];
                if (!handlers || !handlers.length) {
                    if (window.console && window.console.log) {
                        console.log('Trying to unregister listener, but there are none for event: ' + eventName);
                    }

                    return;
                }

                var remainingHandlers = [];
                for (var i = 0; i < handlers.length; ++i) {
                    if (handlers[i] !== handler) {
                        remainingHandlers.push(handlers[i]);
                    }
                }

                eventHandlers[eventName] = remainingHandlers;

                // if last handler ->
                if (!remainingHandlers.length) {
                    channel.unbind(eventName);

                    // unregister listening to event
                    channel.call({
                        method: 'handleEvent',
                        params: [eventName, false],
                        success: function () { return undefined; },

                        error: defaultErrorHandler
                    });
                }
            };

            /**
             * @public @method postRequest
             *
             * @param {string}   request Request name
             * @param {Any[]}       params  Request params
             * @param {function} error   Error handler
             *
             */
            RPC_API.postRequest = function (request, params, error) {
                channel.call({
                    method: 'postRequest',
                    params: [request, params],
                    success: function () { return undefined; },

                    error: error || defaultErrorHandler
                });
            };

            // connect and setup allowed functions
            var __bindFunctionCall = function (name) {
                /**
                 * Any of the allowed functions. Arguments are shifted if params is a function so there's no need to give an empty params array.
                 * @param {Array} params optional array of parameters for the function. Treated as success callback if a function instead.
                 * @param {function} success Callback function
                 * @param {function} error   Error handler
                 */
                RPC_API[name] = function (params, success, error) {
                    if (name === 'getInfo') {
                        // hide params from external getInfo calls
                        error = success;
                        success = params;
                        params = [rpcClientVersion];
                    }

                    if (typeof params === 'function') {
                        error = success;
                        success = params;
                        params = [];
                    }

                    channel.call({
                        method: name,
                        params: params,
                        success: success,
                        error: error || defaultErrorHandler
                    });
                };
            };

            var info;
            RPC_API.isSupported = function (expectedOskariVersion, callback) {
                if (typeof expectedOskariVersion === 'function') {
                    callback = expectedOskariVersion;
                    expectedOskariVersion = null;
                }

                if (typeof callback !== 'function') {
                    callback = function (bln) {
                        RPC_API.log('Callback function for isSupported() not provided. Client supported: ' + bln);
                    };
                }

                var handle = function (oskariInfo) {
                    info = oskariInfo;
                    var supported = oskariInfo.clientSupported;
                    if (expectedOskariVersion) {
                        supported = supported && oskariInfo.version === expectedOskariVersion;
                    }

                    callback(supported);
                };

                if (info) {
                    handle(info);
                } else if (typeof RPC_API.getInfo === 'function') {
                    RPC_API.getInfo(handle);
                } else if (ready) {
                    callback(false);
                } else {
                    throw new Error('Map not connected yet');
                }
            };

            var channel = JSChannel.build({
                window: target.contentWindow,
                origin: origin,
                scope: 'Oskari',
                onReady: function () {
                    channel.call({
                        method: 'getSupportedFunctions',
                        success: function (funcnames) {
                            // setup allowed functions to RPC_API
                            for (var name in funcnames) {
                                if (!funcnames.hasOwnProperty(name)) {
                                    continue;
                                }

                                __bindFunctionCall(name);
                            }

                            // setup ready flag
                            ready = true;

                            // call onReady listeners
                            for (var i = 0; i < readyCallbacks.length; ++i) {
                                readyCallbacks[i]();
                            }
                        },

                        error: function () {
                            // communicate failure
                            throw new Error("Couldn't setup allowed functions");
                        }
                    });
                }
            });
            return RPC_API;
        }
    };
}));
