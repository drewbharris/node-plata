"use strict";

var https = require('https'),
    http = require('http'),
    querystring = require('querystring'),
    crypto = require('crypto'),
    util = require('util'),
    EventEmitter = require('events').EventEmitter,
    common = require('./common'),
    signing = require('./signing'),
    when = require('when'),
    plog = require('plog'),
    log = plog('plata.aws').level('silly');

var protocols = {'http': http, 'https': https};

var retryCodes = [
    'SignatureDoesNotMatch',
    'ThrottlingException',
    'ProvisionedThroughputExceededException',
    'InternalFailure',
    'InternalServerError',
    'ServiceUnavailableException',
    'UnrecognizedClientException'
];

var throttleCodes = [
    'ThrottlingException',
    'ProvisionedThroughputExceededException'
];


function Credentials(data){
    this.key = data.key;
    this.secret = data.secret;
    this.sessionToken = data.sessionToken;
}
module.exports.Credentials = Credentials;

function ClientError(code, message){
    this.code = code.charAt(0).toUpperCase() + code.substr(1, code.length - 1);
    this.message = message;
    ClientError.super_.call(this, message);
}
util.inherits(ClientError, Error);

ClientError.prototype.canRetry = function(){
    return retryCodes.indexOf(this.code) > -1;
};

ClientError.prototype.throttled = function(){
    return throttleCodes.indexOf(this.code) > -1;
};

function Request(service){
    this.params = {};
    this.headers = {};
    this.method = 'POST';
    this.retries = 0;
    this.body = '';
    this.lastError = null;

    this.host = service.host;
    this.path = service.path;
    this.version = service.version;
    this.region = service.region;
    this.signatureVersion = service.signatureVersion || 2;
    this.credentials = service.credentials;
    this.serviceName = service.name;
    this.scope = service.scope;
    this.protocol = service.protocol || 'https';
    this.port = service.port || ((this.protocol === 'http') ? 80 : 443);
    this.isJson = service.contentType === 'json';
}
util.inherits(Request, EventEmitter);
module.exports.Request = Request;

Request.prototype.post = function(){
    this.method = 'POST';
    return this;
};

Request.prototype.get = function(){
    this.method = 'GET';
    return this;
};

Request.prototype.action = function(a){
    var targetBase = this.serviceName + '_'+this.version.replace(/[:\-]|\.\d{3}/g, '')+'.';
    var target = targetBase + a;
    this.headers['x-amz-target'] = target;
    this.headers['Content-Type'] = "application/x-amz-json-1.0";
    return this;
};

Request.prototype.json = function(data){
    if(!data){
        data = {};
    }
    this.body = (data === new Object(data)) ? JSON.stringify(data) : data;
    this.headers['content-length'] = this.body.length;

    return this;
};

Request.prototype.exec = function(){
    var d = when.defer(),
        self = this,
        req,
        signingFunction = signing['V' + this.signatureVersion],
        _ = signingFunction(this, this.credentials),
        opts = {
            'host': this.host,
            'path': this.path,
            'headers': common.cannonicalizeHeaders(this.headers, true),
            'method': this.method,
            'port': this.port
        };

    if(Object.keys(this.params).length > 0){
        opts.path += '?' + querystring.stringify(this.params);
    }

    self.response = '';
    this.retryTimeout = (this.retries !== 0) ? 50 * Math.pow(2, this.retries- 1) : 0;

    req = protocols[this.protocol].request(opts, function(res){
        res.on('data', function(chunk){self.response += chunk;});
        res.on('end', function(){
            // log.debug('Response: ' + res.statusCode + ' ' +  self.response);
            var isJson = self.isJson || res.headers['content-type'] === 'application/json' ||
                    res.headers['content-type'] === 'application/x-amz-json-1.0';

            var result =  isJson ? JSON.parse(self.response)
                    : common.xmlToObject(self.response);

            if(res.statusCode >= 400){
                if(result.hasOwnProperty('errorResponse') || result.hasOwnProperty('message')){
                    if(isJson){
                        self.lastError = new ClientError(result.__type.split('#')[1],
                            result.message);
                    }
                    else{
                        self.lastError = new ClientError(result.errorResponse.error.code,
                            result.errorResponse.error.message);
                    }

                    if(self.lastError.canRetry() && self.retries < 5){
                        self.emit('retry', self.lastError);
                        return setTimeout(function(){
                                self.retries++;
                                self.exec().then(d.resolve, d.reject);
                            }, self.retryTimeout);
                    }
                    else {
                        log.error(self.lastError.message);
                    }
                }
                else{
                    var k = (isJson) ? result.__type.split('#')[1] : Object.keys(result)[0];
                    self.lastError = new ClientError(k, k);
                    log.error(self.lastError.message);
                }
                return d.reject(self.lastError);
            }
            if(this.retries > 0){
                self.emit('successful retry', self.lastError);
            }
            // @todo (lucas) Certain services include request stats in the
            // response that are incredibly useful, but no one does anything
            // with them. We should emit a stat event that contains this info
            // here, ie for Dynamo the consumed capacity units for a reqest,
            // for cloudsearch the info.time-ms and info.cpu-time-ms.

            return d.resolve(result);
        });
    });

    req.on('error', function(e) {
        log.error(e.message);
        log.error(e.stack);
        d.reject(e);
    });

    if (this.body){
        req.write(this.body);
    }

    req.end();
    return d.promise;
};

Request.prototype.end = function(cb){
    return this.exec().then(function(res){
        return cb(res);
    });
};

function Connection(accessKeyId, secretAccessKey, host, version){
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.host = host;
    this.version = version;
    this.autoParseResponse = true;
    this.path = '/';
    this.region = 'us-east-1';

    this.credentials = new Credentials({
        'key': this.accessKeyId,
        'secret': this.secretAccessKey
    });
}
util.inherits(Connection, EventEmitter);

Connection.prototype.getSignature = function(verb, params, headers){
    var str, hmac;
    str = [
        verb,
        this.host.toLowerCase(),
        this.path,
        querystring.stringify(common.sortObjectByKeys(params))
    ].join("\n");

    hmac = crypto.createHmac('sha1', this.secretAccessKey);
    return hmac.update(str).digest('base64');
};

Connection.prototype.request = function(path){
    this.path = path || '/';
    return new Request(this);
};

Connection.prototype.makeRequest = function(cb, action, params, verb, headers, path, retries){
    verb = verb || 'GET';
    params = params || {};
    path = path || '/';
    headers = headers || {};
    retries = retries || 0;

    log.info('make request', {'host': this.host, 'action': action, 'params': params, 'verb': verb, 'headers': headers, 'path': path});


    var d = when.defer(),
        self = this,
        response = '',
        paramString = '',
        opts, req;

    // Set baked params
    params.Action = action;
    params.AWSAccessKeyId = this.accessKeyId;
    params.Version = this.version;
    params.SignatureVersion = 2;
    params.SignatureMethod = 'HmacSHA1';
    params.Timestamp = new Date().toISOString().replace(/\.[0-9]{0,3}Z$/, 'Z');

    // Set up our request
    opts = {
        'host': this.host,
        'path': this.path,
        'headers': {},
        'method': verb
    };

    // If it's a post, be nice and add content type and content length
    if(verb === 'POST'){
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
        opts.headers['Content-Length'] = paramString.length;
    }

    // Copy in optional headers
    Object.keys(headers).forEach(function(key){
        opts.headers[key] = headers[key];
    });

    // Generate Signature param
    params.Signature = this.getSignature(verb, params, opts.headers);
    params = common.sortObjectByKeys(params);

    // Generate param string (same as body for posts)
    paramString = querystring.stringify(params);

    opts.path += '?'+paramString;
    log.silly('request options', opts);
    log.silly('params', params);


    req = https.request(opts, function(res){
        res.on('data', function(chunk){
            response += chunk;
        });
        res.on('end', function(){
            var result = common.xmlToObject(response),
                err;

            log.silly(response);

            if(res.statusCode >= 400){
                if(result.hasOwnProperty('errorResponse')){
                    err = new ClientError(result.errorResponse.error.code,
                        result.errorResponse.error.message);

                    if(err.canRetry() && retries < 5){
                        log.debug('Error is retryable.  Going to retry...');
                        return setTimeout(function(){
                                self.makeRequest(cb, action, params, verb, headers,
                                    path, retries + 1).then(d.resolve, d.reject);
                            }, Number((retries * 100) + 50));
                    }
                    else {
                        log.error(result.errorResponse.error.message);
                        return d.reject(err);
                    }
                }

            }

            return d.resolve(cb(result));
        });
    });

    req.on('error', function(e) {
        log.error(e.message);
        log.error(e.stack);
        d.reject(e);
    });

    req.end((verb === 'POST' ? paramString : ''));
    return d.promise;
};

module.exports.Connection = Connection;
module.exports.log = log;
