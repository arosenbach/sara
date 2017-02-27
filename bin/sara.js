#!/usr/bin/env node

'use strict';

const winston = require('winston');
require('winston-loggly-bulk');
const ps = require('ps-node');
const path = require('path');
const ical = require('ical');
const phone = require('phone');
const fs = require('fs');
const exec = require('child_process').exec;
const argv = require('yargs')
    .count('verbose')
    .alias('v', 'verbose')
    .describe('v', 'Verbose mode')
    .usage('Usage: $0 -c <country code> -d <directory> -m <message> -r <number of days>')
    .alias('d', 'directory')
    .nargs('d', 1)
    .alias('c', 'country')
    .nargs('c', 1)
    .alias('m', 'message')
    .nargs('m', 1)
    .alias('r', 'days')
    .nargs('r', 1)
    .boolean('k')
    .alias('k', 'keep')
    .boolean('n')
    .alias('n', 'dry-run')
    .describe('c', 'Country code used to identify phone numbers (\'fr\' for France)')
    .describe('n', 'Dry-run mode (no SMS will be sent).')
    .describe('k', 'Do not delete *.ics files.')
    .describe('m', 'The message to send. Special word \'[TIME]\' will be replaced by the actual time.')
    .describe('d', 'The directory where *.ics files are put.')
    .describe('r', 'A number that represents the day for which reminders must be sent (eg: 1 for eventsDate).')
    .demandOption(['d', 'm', 'r','c'])
    .help('h')
    .alias('h', 'help')
    .argv;

// Logger initialisation
const transports = [new (winston.transports.Console)()];
if (process.env.LOGGLY_TOKEN) {
    transports.push(new (winston.transports.Loggly)({
        token: process.env.LOGGLY_TOKEN,
        subdomain: process.env.LOGGLY_SUBDOMAIN,
        json: true
    }))
}
const logger = new (winston.Logger)({
    transports: transports
});
switch (argv.verbose) {
    case 0: logger.level = 'info'; break;
    case 1: logger.level = 'verbose'; break;
    case 2: logger.level = 'debug'; break;
}

// Exit if another sara process is running.
ps.lookup({
    command: 'node',
}, function (err, resultList) {
    if (err) {
        throw new Error(err);
    }

    if (resultList.filter(p => p.arguments.join().indexOf('sara.js') > -1 && Number(p.pid) !== Number(process.pid)).length > 0) {
        logger.log('debug', 'Another process is running.', function (err, level, msg, meta) {
            process.exit();
        });
    } else {
        main();
    }
});

const pathToIcs = argv.directory;

function main() {
    if (!fs.existsSync(pathToIcs)) {
        logger.warn('Invalid directory', pathToIcs);
    } else {
        const icsFiles = fs.readdirSync(pathToIcs).filter(f => path.extname(f) === '.ics');
        if (icsFiles.length > 0) {
            const filename = path.join(pathToIcs, icsFiles[0]);
            parseFile(filename);
        } else {
            logger.debug('No *.ics file found.');
        }
    }
}


function isSameDay(actualDate, dateToCheck) {
    return (dateToCheck.getDate() == actualDate.getDate()
        && dateToCheck.getMonth() == actualDate.getMonth()
        && dateToCheck.getFullYear() == actualDate.getFullYear());
}

function extractPhoneNumber(str) {
    if (!str) {
        return null;
    }
    logger.debug('Extracting phone number', str);
    const matches = phone(str, argv.country);
    if (matches && matches.length) {
        return matches[0];
    } else {
        logger.warn('No phone number detected :\'', str, '\'');
        return null;
    }

}

function getMsg(hours, minutes) {
    minutes = (minutes) ? ('0' + minutes).slice(-2) : '00';
    const time = `${hours}:${minutes}`;
    return argv.message.replace('[TIME]', time);
}

function parseFile(file) {
    logger.debug('Parsing', file);
    const data = ical.parseFile(file);
    logger.debug('Parsing done.');
    const today = new Date();
    const eventsDate = new Date();
    eventsDate.setDate(today.getDate() + argv.days);



    Object.keys(data)
        .map(key => data[key])
        .filter(val => val.hasOwnProperty('type') && val.type === 'VEVENT')
        .map(ev => Object.assign(ev, { 'appointmentDate': new Date(ev.start) }))
        .filter(ev => isSameDay(eventsDate, ev.appointmentDate))
        .map(ev => Object.assign(ev, { 'cellPhoneNumber': extractPhoneNumber(ev.description) }))
        .filter(ev => ev.cellPhoneNumber !== null)
        .forEach(
        function (ev) {
            const cmdStr = `gammu-smsd-inject TEXT ${ev.cellPhoneNumber}  -text '${getMsg(ev.appointmentDate.getHours(), ev.appointmentDate.getMinutes())}'`;
            logger.info(ev.summary, ':', cmdStr);
            if (!argv['dry-run']) {
                exec(cmdStr,
                    (error, stdout, stderr) => {
                        logger.debug(`stdout: ${stdout}`);
                        if (stderr !== null && stderr.trim().length > 0) {
                            logger.warn(`stderr: ${stderr}`);
                        }
                        if (error !== null) {
                            logger.warn(`exec error: ${error}`);
                        }
                    });
            }
        });

    if (!argv['dry-run'] || !argv['keep']) {
        fs.unlink(file);
    }
}

