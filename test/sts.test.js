"use strict";

var aws = require('../'),
    sts = require('../lib/services/sts'),
    assert = require('assert'),
    util = require('util');

aws.connect({'file': __dirname + '/auth.json'});

describe("STS", function(){
    it("should get a token", function(done){
        aws.sts.getSessionToken(900).then(function(res){
            console.log('Result', util.inspect(res, true, 10, false));
            done();
        }, done);
    });

    it("should have a nice session object that automatically refreshes itself", function(done){
        var session = aws.sts.Session(900);
        session.on('ready', function(){
            done();
        });
    });

    it("should set a proper refresh time", function(){
        var s = new sts.Session(null, 900);
        assert(s.refreshTime === 840000);
    });
});