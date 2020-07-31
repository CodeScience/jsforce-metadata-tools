'use strict';
var fs = require('fs')
var path = require('path');
var jsforce = require('cs-jsforce');
var archiver = require('archiver');
var Promise = jsforce.Promise;
var connect = require('./connect');

var DEPLOY_OPTIONS =
    "allowMissingFiles,autoUpdatePackage,checkOnly,ignoreWarnings,performRetrieve,purgeOnDelete,rollbackOnError,runAllTests,runTests,singlePackage,testLevel".split(',');

/* @private */
function noop() { }

/**
 *
 */
function deployFromZipStream(zipStream, options) {
    var logger = options.logger || { log: noop };
    return connect(options).then(function (conn) {
        logger.log('Deploying to server...');
        conn.metadata.pollTimeout = options.pollTimeout || 60 * 1000; // timeout in 60 sec by default
        conn.metadata.pollInterval = options.pollInterval || 5 * 1000; // polling interval to 5 sec by default
        var deployOpts = {};
        DEPLOY_OPTIONS.forEach(function (prop) {
            if (typeof options[prop] !== 'undefined') { deployOpts[prop] = options[prop]; }
        });
        return conn.metadata.deploy(zipStream, deployOpts).complete({ details: true });
    });
};

/**
 *
 */
function deployFromFileMapping(mapping, options) {
    var archive = archiver('zip');
    archive.bulk(mapping);
    archive.finalize();
    return deployFromZipStream(archive, options);
}

/**
 *
 */
function deployFromDirectory(packageDirectoryPath, options) {
    return deployFromFileMapping({
        expand: true,
        cwd: path.join(packageDirectoryPath, '..'),
        src: [path.basename(packageDirectoryPath) + '/**'],
    }, options);
}

/**
 *
 */
function deployRecentValidation(id, options) {
    var logger = options.logger || { log: noop };
    return connect(options).then(function (conn) {
        logger.log('Deploying to server...');
        conn.metadata.pollTimeout = options.pollTimeout || 60 * 1000; // timeout in 60 sec by default
        conn.metadata.pollInterval = options.pollInterval || 5 * 1000; // polling interval to 5 sec by default
        var deployOpts = {};
        DEPLOY_OPTIONS.forEach(function (prop) {
            if (typeof options[prop] !== 'undefined') { deployOpts[prop] = options[prop]; }
        });
        return conn.metadata.deployRecentValidation({
            id: id
        }, options);
    });

}

/**
 *
 */
function checkDeployStatus(processId, options) {
    return connect(options).then(function (conn) {
        return conn.metadata.checkDeployStatus(processId, { details: true });
    });
}

/**
 *
 */
function reportDeployResult(res, logger, verbose) {
    var message =
        res.success ? 'Deploy Succeeded' + (res.status === 'SucceededPartial' ? ' Patially.' : '.') :
            res.done ? 'Deploy Failed.' :
                'Deploy Not Completed Yet.';
    logger.log(message);
    logger.log('');
    logger.log('Id: ' + res.id);
    logger.log('Status: ' + res.status);
    logger.log('Success: ' + res.success);
    logger.log('Done: ' + res.done);
    logger.log('Number Component Errors; ' + res.numberComponentErrors);
    logger.log('Number Components Deployed: ' + res.numberComponentsDeployed);
    logger.log('Number Components Total: ' + res.numberComponentsTotal);
    logger.log('Number Test Errors; ' + res.numberTestErrors);
    logger.log('Number Tests Completed: ' + res.numberTestsCompleted);
    logger.log('Number Tests Total: ' + res.numberTestsTotal);
    reportDeployResultDetails(res.details, logger, verbose);
}

function reportDeployResultDetails(details, logger, verbose) {
    if (details) {
        logger.log('');
        if (verbose) {
            var successes = asArray(details.componentSuccesses);
            if (successes.length > 0) {
                logger.log('Successes:');
            }
            successes.forEach(function (s) {
                var flag =
                    String(s.changed) === 'true' ? '(M)' :
                        String(s.created) === 'true' ? '(A)' :
                            String(s.deleted) === 'true' ? '(D)' :
                                '(~)';
                logger.log(' - ' + flag + ' ' + s.fileName + (s.componentType ? ' [' + s.componentType + ']' : ''));
            });
        }
        var failures = asArray(details.componentFailures);
        if (failures) {
            if (failures.length > 0) {
                logger.log('Failures:');
            }
            failures.forEach(function (f) {
                logger.log(
                    ' - ' + f.problemType + ' on ' + f.fileName +
                    (typeof f.lineNumber !== 'undefined' ?
                        ' (' + f.lineNumber + ':' + f.columnNumber + ')' :
                        '') +
                    ' : ' + f.problem
                );
            });
        }
        var testResult = details.runTestResult;
        if (testResult && Number(testResult.numTestsRun) > 0) {
            logger.log('');
            logger.log('Test Total Time: ' + Number(testResult.totalTime));
            logger.log('');
            if (verbose) {
                var testSuccesses = asArray(testResult.successes) || [];
                if (testSuccesses.length > 0) {
                    logger.log('Test Successes:');
                }
                testSuccesses.forEach(function (s) {
                    logger.log(' - ' + (s.namespace ? s.namespace + '__' : '') + s.name + '.' + s.methodName);
                });
            }
            var testFailures = asArray(testResult.failures) || [];
            if (testFailures.length > 0) {
                logger.log('Test Failures:');
            }
            testFailures.forEach(function (f) {
                logger.log(' - ' + (typeof f.namespace === 'string' ? f.namespace + '__' : '') + f.name + '.' + f.methodName);
                logger.log('     ' + f.message);
                if (f.stackTrace && typeof(f.stackTrace) === 'string') {
                    f.stackTrace.split(/\n/).forEach(function (line) {
                        logger.log('        at ' + line);
                    });
                } 
                if (f.message && typeof(f.message) === 'string') {
                    logger.log(f.message);
                }
            });
            if (verbose) {
                var codeCoverages = asArray(testResult.codeCoverage) || [];
                var totalNumLocationsNotCovered;
                var totalNumLocations;
                if (codeCoverages.length > 0) {
                    logger.log('Code Coverage:');
                    totalNumLocationsNotCovered = 0;
                    totalNumLocations = 0;
                }
                codeCoverages.forEach(function (s) {
                    totalNumLocationsNotCovered += s.numLocationsNotCovered;
                    totalNumLocations += s.numLocations;
                    var coverage = Math.floor(100 - 100 * (s.numLocationsNotCovered / s.numLocations));
                    if (isNaN(coverage)) { coverage = 100; }
                    logger.log(
                        ' - ' +
                        '[' +
                        (coverage < 10 ? '  ' : coverage < 100 ? ' ' : '') + coverage +
                        ' %] ' +
                        (typeof s.namespace === 'string' ? s.namespace + '__' : '') + s.name
                    );
                });
                if (codeCoverages.length > 0) {
                    var totalCoverage = Math.floor(100 - 100 * (totalNumLocationsNotCovered / totalNumLocations));
                    if (isNaN(totalCoverage)) { totalCoverage = 100; }
                    logger.log(
                        ' - ' +
                        '[' +
                        (totalCoverage < 10 ? '  ' : totalCoverage < 100 ? ' ' : '') + totalCoverage +
                        ' %] TOTAL COVERAGE'
                    );
                }
            }
        }
    }
}

function asArray(arr) {
    if (!arr) { return []; }
    if (Object.prototype.toString.apply(arr) !== '[object Array]') { arr = [arr]; }
    return arr;
}


/**
 *
 */
module.exports = {
    deployFromZipStream: deployFromZipStream,
    deployFromFileMapping: deployFromFileMapping,
    deployFromDirectory: deployFromDirectory,
    deployRecentValidation: deployRecentValidation,
    checkDeployStatus: checkDeployStatus,
    reportDeployResult: reportDeployResult
};
