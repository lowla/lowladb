/**
 * Created by michael on 9/22/14.
 */

var LowlaDB = (function(LowlaDB) {
  'use strict';

  var generateId = function() {
    /*jshint bitwise:false */
    var i, random;
    var uuid = '';

    for (i = 0; i < 32; i++) {
      random = Math.random() * 16 | 0;
      if (i === 8 || i === 12 || i === 16 || i === 20) {
        uuid += '-';
      }
      uuid += (i === 12 ? 4 : (i === 16 ? (random & 3 | 8) : random)).toString(16);
    }

    return uuid;
  };


  var mutateObject = function(obj, operations) {
    var opMode = false;
    for (var i in operations) {
      if (operations.hasOwnProperty(i)) {
        if (i === '$set') {
          opMode = true;
          for (var j in operations[i]) {
            if (operations[i].hasOwnProperty(j)) {
              obj[j] = operations[i][j];
            }
          }
        }
        else if (i === '$unset') {
          opMode = true;
          for (var j2 in operations[i]) {
            if (obj.hasOwnProperty(j2)) {
              delete obj[j2];
            }
          }
        }
        else {
          if (opMode) {
            throw Error('Can not mix operations and values in object updates');
          }
        }
      }
    }
    if (!opMode) {
      if (!operations.hasOwnProperty('_id') && obj.hasOwnProperty('_id')) {
        operations._id = obj._id;
      }
      return operations;
    }
    else {
      return obj;
    }
  };

  var DB = function (dbName) {
    this.name = dbName;
  };

  DB.prototype.collection = function (collectionName) {
    return new Collection(this.name, collectionName);
  };

  DB.prototype.collectionNames = function () {
    var collection, options, callback;
    var args = Array.prototype.slice.call(arguments, 0);
    while (args.length > 0) {
      var arg = args.pop();
      if (arg instanceof Function) {
        callback = arg;
      }
      else if (typeof(arg) === 'string') {
        collection = arg;
      }
      else if (typeof(arg) === 'object') {
        options = arg;
      }
    }

    options = options || { namesOnly: false };
    collection = collection || '';

    var data = { };
    var dbPrefix = this.name + '.' + collection;
    return new Promise(function(resolve, reject) {
      LowlaDB.Datastore.scanDocuments({
        document: function(clientId) {
          if (clientId.indexOf(dbPrefix) === 0) {
            var dollar = clientId.indexOf('$');
            var fullName = clientId.substring(0, dollar);
            data[fullName] = true;
          }

        },
        done: function() {
          return resolve(data);
        },
        error: reject
      });
    })
      .then(function(data) {
        var answer = [];
        for (var dbCollName in data) {
          if (data.hasOwnProperty(dbCollName)) {
            if (options.namesOnly) {
              answer.push(dbCollName);
            }
            else {
              answer.push({name: dbCollName});
            }
          }
        }

        return answer;
      })
      .then(function(answer) {
        if (callback) {
          callback(null, answer);
        }
        return answer;
      }, function(err) {
        if (callback) {
          callback(err);
        }
        throw err;
      });
  };

  var Collection = function (dbName, collectionName) {
    this.dbName = dbName;
    this.collectionName = collectionName;
  };

  Collection.prototype._updateDocument = function(obj, flagEight) {
    var coll = this;
    obj._id = obj._id || generateId();
    var lowlaID = coll.dbName + '.' + coll.collectionName + '$' + obj._id;

    var answer;
    if (!flagEight) {
      answer = LowlaDB.utils.metaData()
        .then(function(metaDoc) {
          if (!metaDoc || !metaDoc.changes || !metaDoc.changes[lowlaID]) {
            return new Promise(function(resolve, reject) {
              LowlaDB.Datastore.loadDocument(lowlaID, resolve, reject);
            })
              .then(function(oldDoc) {
                oldDoc = oldDoc || {};
                return new Promise(function(resolve, reject) {
                  metaDoc = metaDoc || { changes: {} };
                  metaDoc.changes = metaDoc.changes || [];
                  metaDoc.changes[lowlaID] = oldDoc;
                  LowlaDB.Datastore.updateDocument("$metadata", metaDoc, resolve, reject);
                });
              });
          }
        });
    }
    else {
      answer = Promise.resolve({});
    }

    return answer
      .then(function() {
        return new Promise(function(resolve, reject) {
          LowlaDB.Datastore.updateDocument(lowlaID, obj, resolve, reject);
        });
      })
      .then(function(doc) {
        LowlaDB.Cursor.notifyLive(coll);
        return doc;
      });

  };

  Collection.prototype.insert = function(obj, callback) {
    return this._updateDocument(obj)
      .then(function(savedObj) {
        if (callback) {
          callback(null, savedObj);
        }
        return savedObj;
      })
      .catch(function(e) {
        if (callback) {
          callback(e);
        }
        throw e;
      });
  };

  Collection.prototype.findOne = function(filter, callback) {
    return LowlaDB.Cursor(this, filter).limit(1).toArray().then(function(arr) {
      var obj = (arr && arr.length > 0) ? arr[0] : undefined;
      if (callback) {
        callback(null, obj);
      }
      return obj;
    }, function(err) {
      if (callback) {
        callback(err);
      }
      throw err;
    });
  };

  Collection.prototype.find = function(filter) {
    return LowlaDB.Cursor(this, filter);
  };


  Collection.prototype.findAndModify = function(filter, operations, callback) {
    var coll = this;
    return this.find(filter).toArray()
      .then(function(arr) {
        if (0 === arr.length) {
          return null;
        }

        var obj = mutateObject(arr[0], operations);
        return coll._updateDocument(obj);
      });
  };

  Collection.prototype.remove = function(filter) {
    var coll = this;
    return this.find(filter).toArray()
      .then(function(arr) {
        return new Promise(function(resolve, reject) {
          if (0 === arr.length) {
            resolve(0);
            return;
          }

          return Promise.all(arr.map(function(obj) {
            return new Promise(function(resolve, reject) {
              var objId = coll.dbName + '.' + coll.collectionName + '$' + obj._id;
              LowlaDB.Datastore.deleteDocument(objId, {
                done: function() { resolve(1); },
                error: function() { reject(0); }
              });
            });
          }))
            .then(function(deleted) {
              resolve(deleted.length);
              LowlaDB.Cursor.notifyLive(coll);
            })
            .catch(function(err) {
              reject(err);
            });
        });
      });
  };

  Collection.prototype.count = function(query) {
    return this.find(query).count();
  };

  LowlaDB.db = function (dbName) {
    return new DB(dbName);
  };

  LowlaDB.collection = function(dbName, collectionName) {
    return new Collection(dbName, collectionName);
  };

  LowlaDB.sync = function(serverUrl, options) {
    LowlaDB._syncCoordinator = new LowlaDB.SyncCoordinator(serverUrl, options);
    if (options && -1 == options.pollFrequency) {
      return;
    }

    var pushPull = function() {
      return LowlaDB._syncCoordinator.pushChanges()
        .then(function() {
          return LowlaDB._syncCoordinator.fetchChanges();
        });
    };

    return pushPull().then(function () {
      if (options && 0 !== options.pollFrequency) {
        var pollFunc = function () {
          pushPull().then(function () {
              setTimeout(pollFunc, options.pollFrequency);
            });
        };

        setTimeout(pollFunc, options.pollFrequency);
      }
    }, function (err) {
      throw err;
    });
  };

  LowlaDB.close = function() {
    LowlaDB.Datastore.close();
  };

  return LowlaDB;
}
)(LowlaDB || {});