/*
  2022-07-22

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  This file is the tail end of the sqlite3-api.js constellation,
  intended to be appended after all other files so that it can clean
  up any global systems temporarily used for setting up the API's
  various subsystems.
*/
'use strict';
(function(){
  /**
     Replace sqlite3ApiBootstrap() with a variant which plugs in the
     Emscripten-based config for all config options which the client
     does not provide.
  */
  const SAB = self.sqlite3ApiBootstrap;
  self.sqlite3ApiBootstrap = function(apiConfig){
    apiConfig = apiConfig||{};
    const configDefaults = {
      Module: Module /* ==> Emscripten-style Module object. Currently
                        needs to be exposed here for test code. NOT part
                        of the public API. */,
      exports: Module['asm'],
      memory: Module.wasmMemory /* gets set if built with -sIMPORT_MEMORY */
    };
    const config = {};
    Object.keys(configDefaults).forEach(function(k){
      config[k] = Object.prototype.hasOwnProperty.call(apiConfig, k)
        ? apiConfig[k] : configDefaults[k];
    });
    return SAB(config);
  };

  /**
     For current (2022-08-22) purposes, automatically call sqlite3ApiBootstrap().
     That decision will be revisited at some point, as we really want client code
     to be able to call this to configure certain parts.
   */
  const sqlite3 = self.sqlite3ApiBootstrap();

  if(self.location && +self.location.port > 1024){
    console.warn("Installing sqlite3 bits as global S for dev-testing purposes.");
    self.S = sqlite3;
  }

  /* Clean up temporary references to our APIs... */
  delete self.sqlite3ApiBootstrap;
  Module.sqlite3 = sqlite3 /* Currently needed by test code */;
  delete sqlite3.capi.util /* arguable, but these are (currently) internal-use APIs */;
  //console.warn("Module.sqlite3 =",Module.sqlite3);
})();
