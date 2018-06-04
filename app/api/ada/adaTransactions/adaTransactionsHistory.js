// @flow
import _ from 'lodash';
import moment from 'moment';
import BigNumber from 'bignumber.js';
import {
  getTransactionsHistoryForAddresses,
  transactionsLimit,
  addressesLimit
} from '../lib/icarus-backend-api';
import {
  saveInStorage
} from '../lib/utils';
import {
  getLastBlockNumber,
  saveLastBlockNumber
} from '../getAdaLastBlockNumber';
import { getAdaTransactions } from './adaTransactions';

const TX_KEY = 'TXS'; // single txs list atm

export const getAdaTxsHistoryByWallet = (): Promise<AdaTransactions> => {
  const transactions = getAdaTransactions();
  return Promise.resolve([transactions, transactions.length]);
};

/* FIXME: uniqWith should be applied only to the newTransactions and the most recent
   transactions, considering that recent transactions shouldn't be stored again . */

export async function updateAdaTxsHistory(
  existedTransactions: Array<AdaTransaction>,
  addresses: Array<string>
) {
  const mostRecentTx = existedTransactions[0];
  const dateFrom = mostRecentTx ?
    moment(mostRecentTx.ctMeta.ctmDate) :
    moment(new Date(0));
  const groupsOfAddresses = _.chunk(addresses, addressesLimit);
  const promises = groupsOfAddresses.map(groupOfAddresses =>
    _updateAdaTxsHistoryForGroupOfAddresses([], groupOfAddresses, dateFrom, addresses)
  );
  return Promise.all(promises)
  .then((groupsOfTransactions) => {
    const groupedTransactions = groupsOfTransactions
      .reduce((acc, groupOfTransactions) => acc.concat(groupOfTransactions), []);
    const newTransactions = _sortTransactionsByDate(groupedTransactions);
    const updatedTransactions = _.uniqWith(
      newTransactions.concat(existedTransactions),
      (txA, txB) => txA.ctId === txB.ctId
    );
    saveInStorage(TX_KEY, updatedTransactions);
    return updatedTransactions;
  });
}

// FIXME: refactor the repeated code from updateAdaTxsHistory
async function _updateAdaTxsHistoryForGroupOfAddresses(
  previousTransactions,
  groupOfAddresses,
  dateFrom,
  allAddresses
) {
  const mostRecentTx = previousTransactions[0];
  const updatedDateFrom = mostRecentTx ?
    moment(mostRecentTx.ctMeta.ctmDate) :
    dateFrom;
  const history = await getTransactionsHistoryForAddresses(groupOfAddresses, updatedDateFrom);
  if (history.length > 0) {
    const latestTransactions = _mapTransactions(history, allAddresses);
    const transactions = _.uniqWith(
      latestTransactions.concat(previousTransactions),
      (txA, txB) => txA.ctId === txB.ctId
    );
    if (history.length === transactionsLimit) {
      return await _updateAdaTxsHistoryForGroupOfAddresses(
        transactions,
        groupOfAddresses,
        dateFrom,
        allAddresses
      );
    }
    return Promise.resolve(transactions);
  }
  return Promise.resolve(previousTransactions);
}

function _sortTransactionsByDate(transactions) {
  return transactions.sort((txA, txB) => {
    const txADate = new Date(txA.ctMeta.ctmDate);
    const txBDate = new Date(txB.ctMeta.ctmDate);
    if (txADate > txBDate) return -1;
    if (txADate < txBDate) return 1;
    return 0;
  });
}


function _mapTransactions(
  transactions: [],
  accountAddresses,
): Array<AdaTransaction> {
  return transactions.map(tx => {
    const inputs = _mapInputOutput(tx.inputs_address, tx.inputs_amount);
    const outputs = _mapInputOutput(tx.outputs_address, tx.outputs_amount);
    const { isOutgoing, amount } = _spenderData(inputs, outputs, accountAddresses);
    const isPending = tx.block_num === null;
    if (!getLastBlockNumber() || tx.best_block_num > getLastBlockNumber()) {
      saveLastBlockNumber(tx.best_block_num);
    }
    return {
      ctAmount: {
        getCCoin: amount
      },
      ctBlockNumber: tx.block_num,
      ctId: tx.hash,
      ctInputs: inputs,
      ctIsOutgoing: isOutgoing,
      ctMeta: {
        ctmDate: tx.time,
        ctmDescription: undefined,
        ctmTitle: undefined
      },
      ctOutputs: outputs,
      ctCondition: isPending ? 'CPtxApplying' : 'CPtxInBlocks'
    };
  });
}

function _mapInputOutput(addresses, amounts): AdaTransactionInputOutput {
  return addresses.map((address, index) => [address, { getCCoin: amounts[index] }]);
}


function _spenderData(txInputs, txOutputs, addresses) {
  const sum = toSum =>
    toSum.reduce(
      ({ totalAmount, count }, [address, { getCCoin }]) => {
        if (addresses.indexOf(address) < 0) return { totalAmount, count };
        return {
          totalAmount: totalAmount.plus(new BigNumber(getCCoin)),
          count: count + 1
        };
      },
      {
        totalAmount: new BigNumber(0),
        count: 0
      }
    );

  const incoming = sum(txOutputs);
  const outgoing = sum(txInputs);

  const isOutgoing = outgoing.totalAmount.greaterThanOrEqualTo(
    incoming.totalAmount
  );

  const isLocal =
    incoming.count === txInputs.length &&
    outgoing.count === txOutputs.length;

  let amount;
  if (isLocal) amount = outgoing.totalAmount;
  else if (isOutgoing) amount = outgoing.totalAmount - incoming.totalAmount;
  else amount = incoming.totalAmount - outgoing.totalAmount;

  return {
    isOutgoing,
    amount
  };
}