"use strict";

var util = require('util'),
    crypto = require('crypto'),
    Connection = require('../aws').Connection,
    log = require('../aws').log,
    when = require('when'),
    https = require('https'),
    common = require('../common'),
    winston = require('winston'),
    querystring = require('querystring');

function EC2(accessKeyId, secretAccessKey){
    EC2.super_.call(this, accessKeyId, secretAccessKey,
        'ec2.amazonaws.com', '2011-12-15');
}

util.inherits(EC2, Connection);

EC2.prototype.describeAvailabilityZones = function(){
    return this.makeRequest(function(response){
        return response;
    }, 'DescribeAvailabilityZones', {});
};

EC2.prototype.describeRegions = function(){
    return this.makeRequest(function(response){
        return response;
    }, 'DescribeRegions', {});
};

EC2.prototype.describeInstances = function(){
    return this.makeRequest(function(response){
        return response;
    }, 'DescribeInstances', {});
};

module.exports.EC2 = EC2;