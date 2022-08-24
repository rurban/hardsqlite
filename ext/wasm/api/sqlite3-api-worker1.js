/*
  2022-07-22

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  This file implements the initializer for the sqlite3 "Worker API
  #1", a very basic DB access API intended to be scripted from a main
  window thread via Worker-style messages. Because of limitations in
  that type of communication, this API is minimalistic and only
  capable of serving relatively basic DB requests (e.g. it cannot
  process nested query loops concurrently).

  This file requires that the core C-style sqlite3 API and OO API #1
  have been loaded.
*/

/**
  This function implements a Worker-based wrapper around SQLite3 OO
  API #1, colloquially known as "Worker API #1".

  In order to permit this API to be loaded in worker threads without
  automatically registering onmessage handlers, initializing the
  worker API requires calling initWorker1API(). If this function
  is called from a non-worker thread then it throws an exception.

  When initialized, it installs message listeners to receive Worker
  messages and then it posts a message in the form:

  ```
  {type:'sqlite3-api',result:'worker1-ready'}
  ```

  to let the client know that it has been initialized. Clients may
  optionally depend on this function not returning until
  initialization is complete, as the initialization is synchronous.
  In some contexts, however, listening for the above message is
  a better fit.

  Note that the worker-based interface can be slightly quirky because
  of its async nature. In particular, any number of messages may be posted
  to the worker before it starts handling any of them. If, e.g., an
  "open" operation fails, any subsequent messages will fail. The
  Promise-based wrapper for this API (`sqlite3-worker1-promiser.js`)
  is more comfortable to use in that regard.


  TODO: hoist the message API docs from deep in this code to here.

*/
self.sqlite3ApiBootstrap.initializers.push(function(sqlite3){
sqlite3.initWorker1API = function(){
  'use strict';
  const toss = (...args)=>{throw new Error(args.join(' '))};
  if('function' !== typeof importScripts){
    toss("Cannot initalize the sqlite3 worker API in the main thread.");
  }
  const self = this.self;
  const sqlite3 = this.sqlite3 || toss("Missing this.sqlite3 object.");
  const SQLite3 = sqlite3.oo1 || toss("Missing this.sqlite3.oo1 OO API.");
  const DB = SQLite3.DB;

  /**
     Returns the app-wide unique ID for the given db, creating one if
     needed.
  */
  const getDbId = function(db){
    let id = wState.idMap.get(db);
    if(id) return id;
    id = 'db#'+(++wState.idSeq)+'@'+db.pointer;
    /** ^^^ can't simply use db.pointer b/c closing/opening may re-use
        the same address, which could map pending messages to a wrong
        instance. */
    wState.idMap.set(db, id);
    return id;
  };

  /**
     Internal helper for managing Worker-level state.
  */
  const wState = {
    defaultDb: undefined,
    idSeq: 0,
    idMap: new WeakMap,
    xfer: [/*Temp holder for "transferable" postMessage() state.*/],
    open: function(opt){
      const db = new DB(opt.filename);
      this.dbs[getDbId(db)] = db;
      if(!this.defaultDb) this.defaultDb = db;
      return db;
    },
    close: function(db,alsoUnlink){
      if(db){
        delete this.dbs[getDbId(db)];
        const filename = db.fileName();
        db.close();
        if(db===this.defaultDb) this.defaultDb = undefined;
        if(alsoUnlink && filename){
          sqlite3.capi.sqlite3_wasm_vfs_unlink(filename);
        }
      }
    },
    /**
       Posts the given worker message value. If xferList is provided,
       it must be an array, in which case a copy of it passed as
       postMessage()'s second argument and xferList.length is set to
       0.
    */
    post: function(msg,xferList){
      if(xferList && xferList.length){
        self.postMessage( msg, Array.from(xferList) );
        xferList.length = 0;
      }else{
        self.postMessage(msg);
      }
    },
    /** Map of DB IDs to DBs. */
    dbs: Object.create(null),
    getDb: function(id,require=true){
      return this.dbs[id]
        || (require ? toss("Unknown (or closed) DB ID:",id) : undefined);
    }
  };

  /** Throws if the given db is falsy or not opened. */
  const affirmDbOpen = function(db = wState.defaultDb){
    return (db && db.pointer) ? db : toss("DB is not opened.");
  };

  /** Extract dbId from the given message payload. */
  const getMsgDb = function(msgData,affirmExists=true){
    const db = wState.getDb(msgData.dbId,false) || wState.defaultDb;
    return affirmExists ? affirmDbOpen(db) : db;
  };

  const getDefaultDbId = function(){
    return wState.defaultDb && getDbId(wState.defaultDb);
  };

  /**
     A level of "organizational abstraction" for the Worker
     API. Each method in this object must map directly to a Worker
     message type key. The onmessage() dispatcher attempts to
     dispatch all inbound messages to a method of this object,
     passing it the event.data part of the inbound event object. All
     methods must return a plain Object containing any result
     state, which the dispatcher may amend. All methods must throw
     on error.
  */
  const wMsgHandler = {
    /**
       Proxy for the DB constructor. Expects to be passed a single
       object or a falsy value to use defaults:

       {
         filename [=":memory:" or "" (unspecified)]: the db filename.
         See the sqlite3.oo1.DB constructor for peculiarities and transformations,

         persistent [=false]: if true and filename is not one of ("",
         ":memory:"), prepend
         sqlite3.capi.sqlite3_web_persistent_dir() to the given
         filename so that it is stored in persistent storage _if_ the
         environment supports it.  If persistent storage is not
         supported, the filename is used as-is.
       }

       The response object looks like:

       {
         filename: db filename, possibly differing from the input.

         dbId: an opaque ID value which must be passed in the message
         envelope to other calls in this API to tell them which db to
         use. If it is not provided to future calls, they will default
         to operating on the first-opened db.

         persistent: true if the given filename resides in the
         known-persistent storage, else false. This determination is
         independent of the `persistent` input argument.
       }
    */
    open: function(ev){
      const oargs = Object.create(null), args = (ev.args || Object.create(null));
      if(args.simulateError){ // undocumented internal testing option
        toss("Throwing because of simulateError flag.");
      }
      const rc = Object.create(null);
      const pDir = sqlite3.capi.sqlite3_web_persistent_dir();
      if(!args.filename || ':memory:'===args.filename){
        oargs.filename = args.filename || '';
      }else if(pDir){
        oargs.filename = pDir + ('/'===args.filename[0] ? args.filename : ('/'+args.filename));
      }else{
        oargs.filename = args.filename;
      }
      const db = wState.open(oargs);
      rc.filename = db.filename;
      rc.persistent = !!pDir && db.filename.startsWith(pDir);
      rc.dbId = getDbId(db);
      return rc;
    },
    /**
       Proxy for DB.close(). ev.args may be elided or an object with
       an `unlink` property. If that value is truthy then the db file
       (if the db is currently open) will be unlinked from the virtual
       filesystem, else it will be kept intact, noting that unlink
       failure is ignored. The result object is:

       {
         filename: db filename _if_ the db is opened when this
         is called, else the undefined value

         dbId: the ID of the closed b, or undefined if none is closed
       }

       It does not error if the given db is already closed or no db is
       provided. It is simply does nothing useful in that case.
    */
    close: function(ev){
      const db = getMsgDb(ev,false);
      const response = {
        filename: db && db.filename,
        dbId: db && getDbId(db)
      };
      if(db){
        wState.close(db, ((ev.args && 'object'===typeof ev.args)
                          ? !!ev.args.unlink : false));
      }
      return response;
    },
    /**
       Proxy for oo1.DB.exec() which expects a single argument of type
       string (SQL to execute) or an options object in the form
       expected by exec(). The notable differences from exec()
       include:

       - The default value for options.rowMode is 'array' because
       the normal default cannot cross the window/Worker boundary.

       - A function-type options.callback property cannot cross
       the window/Worker boundary, so is not useful here. If
       options.callback is a string then it is assumed to be a
       message type key, in which case a callback function will be
       applied which posts each row result via:

       postMessage({type: thatKeyType, rowNumber: 1-based-#, row: theRow})

       And, at the end of the result set (whether or not any result
       rows were produced), it will post an identical message with
       (row=undefined, rowNumber=null) to alert the caller than the
       result set is completed. Note that a row value of `null` is
       a legal row result for certain `rowMode` values.

       (Design note: we don't use (row=undefined, rowNumber=undefined)
       to indicate end-of-results because fetching those would be
       indistinguishable from fetching from an empty object unless the
       client used hasOwnProperty() (or similar) to distinguish
       "missing property" from "property with the undefined value".
       Similarly, `null` is a legal value for `row` in some case ,
       whereas the db layer won't emit a result value of `undefined`.)

       The callback proxy must not recurse into this interface, or
       results are undefined. (It hypothetically cannot recurse
       because an exec() call will be tying up the Worker thread,
       causing any recursion attempt to wait until the first
       exec() is completed.)

       The response is the input options object (or a synthesized
       one if passed only a string), noting that
       options.resultRows and options.columnNames may be populated
       by the call to db.exec().
    */
    exec: function(ev){
      const rc = (
        'string'===typeof ev.args
      ) ? {sql: ev.args} : (ev.args || Object.create(null));
      if(undefined===rc.rowMode){
        /* Since the default rowMode of 'stmt' is not useful
           for the Worker interface, we'll default to
           something else. */
        rc.rowMode = 'array';
      }else if('stmt'===rc.rowMode){
        toss("Invalid rowMode for 'exec': stmt mode",
             "does not work in the Worker API.");
      }
      const db = getMsgDb(ev);
      if(rc.callback || Array.isArray(rc.resultRows)){
        // Part of a copy-avoidance optimization for blobs
        db._blobXfer = wState.xfer;
      }
      const callbackMsgType = rc.callback;
      let rowNumber = 0;
      if('string' === typeof callbackMsgType){
        /* Treat this as a worker message type and post each
           row as a message of that type. */
        rc.callback =
          (row)=>wState.post({type: callbackMsgType, rowNumber:++rowNumber, row:row}, wState.xfer);
      }
      try {
        db.exec(rc);
        if(rc.callback instanceof Function){
          rc.callback = callbackMsgType;
          wState.post({type: callbackMsgType, rowNumber: null, row: undefined});
        }
      }finally{
        delete db._blobXfer;
        if(rc.callback){
          rc.callback = callbackMsgType;
        }
      }
      return rc;
    }/*exec()*/,
    /**
       Returns a JSON-friendly form of a _subset_ of sqlite3.config,
       sans any parts which cannot be serialized. Because we cannot,
       from here, distingush whether or not certain objects can be
       serialized, this routine selectively copies certain properties
       rather than trying JSON.stringify() and seeing what happens
       (the results are horrid if the config object contains an
       Emscripten module object).

       In addition to the "real" config properties, it sythesizes
       the following:

       - persistenceEnabled: true if persistent dir support is available,
       else false.
    */
    'config-get': function(){
      const rc = Object.create(null), src = sqlite3.config;
      [
        'persistentDirName', 'bigIntEnabled'
      ].forEach(function(k){
        if(Object.getOwnPropertyDescriptor(src, k)) rc[k] = src[k];
      });
      rc.persistenceEnabled = !!sqlite3.capi.sqlite3_web_persistent_dir();
      return rc;
    },
    /**
       TO(RE)DO, once we can abstract away access to the
       JS environment's virtual filesystem. Currently this
       always throws.

       Response is (should be) an object:

       {
         buffer: Uint8Array (db file contents),
         filename: the current db filename,
         mimetype: 'application/x-sqlite3'
       }

       TODO is to determine how/whether this feature can support
       exports of ":memory:" and "" (temp file) DBs. The latter is
       ostensibly easy because the file is (potentially) on disk, but
       the former does not have a structure which maps directly to a
       db file image. We can VACUUM INTO a :memory:/temp db into a
       file for that purpose, though.
    */
    export: function(ev){
      toss("export() requires reimplementing for portability reasons.");
      /**
         We need to reimplement this to use the Emscripten FS
         interface. That part used to be in the OO#1 API but that
         dependency was removed from that level of the API.
      */
      /**const db = getMsgDb(ev);
      const response = {
        buffer: db.exportBinaryImage(),
        filename: db.filename,
        mimetype: 'application/x-sqlite3'
      };
      wState.xfer.push(response.buffer.buffer);
      return response;**/
    }/*export()*/,
    toss: function(ev){
      toss("Testing worker exception");
    }
  }/*wMsgHandler*/;

  /**
     UNDER CONSTRUCTION!

     A subset of the DB API is accessible via Worker messages in the
     form:

     { type: apiCommand,
       args: apiArguments,
       dbId: optional DB ID value (else uses a default db handle),
       messageId: optional client-specific value
     }

     As a rule, these commands respond with a postMessage() of their
     own. The responses always have a `type` property equal to the
     input message's type and an object-format `result` part. If
     the inbound object has a `messageId` property, that property is
     always mirrored in the result object, for use in client-side
     dispatching of these asynchronous results. For example:

     {
       type: 'open',
       messageId: ...copied from inbound message...,
       dbId: ID of db which was opened,
       result: {
         dbId: repeat of ^^^, for API consistency's sake,
         filename: ...,
         persistent: false
       },
       ...possibly other framework-internal/testing/debugging info...
     }

     Exceptions thrown during processing result in an `error`-type
     event with a payload in the form:

     { type: 'error',
       dbId: DB handle ID,
       [messageId: if set in the inbound message],
       result: {
         operation: "inbound message's 'type' value",
         message: error string,
         errorClass: class name of the error type,
         input: ev.data
       }
     }

     The individual APIs are documented in the wMsgHandler object.
  */
  self.onmessage = function(ev){
    ev = ev.data;
    let result, dbId = ev.dbId, evType = ev.type;
    const arrivalTime = performance.now();
    try {
      if(wMsgHandler.hasOwnProperty(evType) &&
         wMsgHandler[evType] instanceof Function){
        result = wMsgHandler[evType](ev);
      }else{
        toss("Unknown db worker message type:",ev.type);
      }
    }catch(err){
      evType = 'error';
      result = {
        operation: ev.type,
        message: err.message,
        errorClass: err.name,
        input: ev
      };
      if(err.stack){
        result.stack = ('string'===typeof err.stack)
          ? err.stack.split('\n') : err.stack;
      }
      if(0) console.warn("Worker is propagating an exception to main thread.",
                         "Reporting it _here_ for the stack trace:",err,result);
    }
    if(!dbId){
      dbId = result.dbId/*from 'open' cmd*/
        || getDefaultDbId();
    }
    // Timing info is primarily for use in testing this API. It's not part of
    // the public API. arrivalTime = when the worker got the message.
    wState.post({
      type: evType,
      dbId: dbId,
      messageId: ev.messageId,
      workerReceivedTime: arrivalTime,
      workerRespondTime: performance.now(),
      departureTime: ev.departureTime,
      // TODO: move the timing bits into...
      //timing:{
      //  departure: ev.departureTime,
      //  workerReceived: arrivalTime,
      //  workerResponse: performance.now();
      //},
      result: result
    }, wState.xfer);
  };
  self.postMessage({type:'sqlite3-api',result:'worker1-ready'});
}.bind({self, sqlite3});
});
