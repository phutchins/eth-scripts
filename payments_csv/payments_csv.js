'use strict'

// Usage
// For usage view the help...
// $ node payments_csv.js --help

// TODO
// - Log output to a file named after the input file including txids
// - Check the number of gwei required to send payments using an api?

// Pre-Flight Checks
// Ensure that there is enough STORJ to cover transactions
// Ensure that there is enough ETH to cover fees

const fs = require('fs');
const parse = require('csv-parse');
const async = require('async');
const levelup = require('levelup');
const program = require('commander');

const Web3 = require('web3')
const web3 = new Web3(new Web3.providers.HttpProvider("http://localhost:8545"));
const tokenAbi = require('./tokenAbi.js');
const walletAbi = require('./walletAbi.js');

program
  .version('0.0.1')
  .usage('[options]')
  .option(
    '-f, --file [filename]',
    'CSV file to use for payments with headers of addr,amnt',
    'File msut exist in ./data/'
  )
  .option(
    '-a, --address [address]',
    'Wallet address to make payments from'
  )
  .parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
  process.exit(1);
}

const inputFileName = './data/' + program.file;
const datFolderName = program.file.split('.')[0] + '.dat';
const db = levelup(datFolderName);
const fromAccountAddr = program.address;;

// This is the contract address for the ERC20 token that we are transacting with
const storjTokenAddr = "0xb64ef51c888972c908cfacf59b47c1afbc0ab8ac";
const tokenInst = web3.eth.contract(tokenAbi).at(storjTokenAddr);
const fromAccount = web3.eth.accounts[web3.eth.accounts.indexOf(fromAccountAddr.toLowerCase())];

if (!fromAccount) {
  console.log('Could not find account for %s', fromAccountAddr);
  console.log('Available accounts %j', web3.eth.accounts);
  process.exit(1);
}

web3.eth.defaultAccount = fromAccount;

var fromAccountBalance = parseFloat(tokenInst.balanceOf(fromAccountAddr)/100000000);

console.log('Operating on Token \'%s\'', tokenInst.symbol());
console.log('Using from account of %s', fromAccount);

fs.readFile(inputFileName, function(err, data) {
  if (err) {
    console.log('Error finding input file path: %s', err.message);
  };

  parse(data, {columns: true}, function(err, row) {
    if (err) {
      console.error('Error reading CSV file: %s', err.message);
      process.exit(1);
    };

    async.eachSeries(row, function(entry, next) {
      db.get(entry.addr, function(err, value) {
        // Check completed payouts to make sure we haven't made this payment already
        if (err && err.notFound) {

          if (entry.amnt == NaN) {
            return next('amnt is NaN');
          }

          if (entry.amnt <= 0 || entry.amnt == "0") {
            return next();
          }

          if (typeof entry.amnt == 'undefined') {
            return next('amnt undefined');
          }

          sendTokens(entry.addr, entry.amnt, function(err, txhash) {
            if (err) {
              return next(err);
            }
            // Record that we've sent to this address
            const value = JSON.stringify({address: entry.addr, amnt: entry.amnt, hash: txhash});

            db.put(entry.addr, value, next);
            fromAccountBalance -= entry.amnt;
          });

        } else {
          // If its in the DB but the actual payout amount was 0, pay it again
          const data = JSON.parse(value);

          web3.eth.getTransaction(data.hash, function(err, tx) {
            if (err) {
              console.log('Error looking up TXID %s for address %s', data.hash, entry.addr);

              return next();
            } else if (tx == null) {
              console.log('TX %s for addr %s is null, repaying', data.hash, entry.addr);

              sendTokens(entry.addr, entry.amnt, function(err, txhash) {
                if (err) {
                  return next(err);
                }

                // Update that we've sent to this address
                const value = JSON.stringify({address: entry.addr, amnt: entry.amnt, hash: txhash});

                db.put(entry.addr, value, next);
                fromAccountBalance -= entry.amnt;
              });

            } else {
              return setImmediate(next);
            }
          });
        }
      })
    }, function(err) {
      if (err) {
        console.error('Unable to complete, there was an error.');
        console.error(err);
        process.exit(1);
      }
      console.log('Done!');
    });
  });
});

function sendTokens(sendToAddr, sendTokenAmnt, callback) {
  //const staticGas = 250000;
  const staticGas = 250000;
  const txGasPrice = web3.toWei(4, 'gwei');
  const finalSendTokenAmnt = parseInt((sendTokenAmnt * 1e8).toFixed(0))

  if (fromAccountBalance < sendTokenAmnt) {
    return callback('Balance of %s is too low to make payment of %s', fromAccountBalance, sendTokenAmnt);
  }

  // Check properly formatted address
  if (!web3._extend.utils.isAddress(sendToAddr)) {
    console.log('Supplied address ' + sendToAddr + ' is incorrect');
    return callback();
  }

  // Check supplied token amount is greater than 0
  if (sendTokenAmnt < 0) {
    console.log('Must approve greater than 0 tokens for address ' + sendToAddr);
    return callback();
  }

  let txhash = {};

  try {
    txhash = tokenInst.transfer(sendToAddr, finalSendTokenAmnt, {gas: staticGas, gasPrice: txGasPrice});
  } catch(err) {
    return callback(err);
  }

    console.log('[BAL: %s] Sent %s (%s) tokens to %s from account %s - txhash is %s',
    fromAccountBalance, sendTokenAmnt, finalSendTokenAmnt, sendToAddr, fromAccount,
    txhash.toString());

  callback(null, txhash);
}
