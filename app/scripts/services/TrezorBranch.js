'use strict';

angular.module('webwalletApp')
  .factory('TrezorBranch', function (utils, trezor, Bitcoin, $q) {

    function TrezorBranch(node, backend) {
      this.node = node;
      this._backend = backend;
      this._subscription = null;
      this._subscriptionDfd = null;
      this._transactions = null;
      this._offset = null;
      this._utxos = null;
    }

    TrezorBranch.prototype.register = function () {
      return this._backend.register(this.node);
    };

    TrezorBranch.prototype.deregister = function () {
      return this._backend.deregister(this.node);
    };

    TrezorBranch.prototype.subscribe = function (handlers) {
      var self = this;

      this._subscriptionDfd = $q.defer();
      this._subscription = this._backend.subscribe(this.node, function (details) {
        self._processDetailsUpdate(details, handlers);
      });

      return this._subscriptionDfd.promise;
    };

    TrezorBranch.prototype.unsubscribe = function () {
      if (this._subscription)
        this._subscription.unsubscribe();
    };

    TrezorBranch.prototype.address = function (n, coin) {
      var index = this._offset + n,
          child = trezor.deriveChildNode(this.node, index),
          address = utils.node2address(child, coin.address_type);

      return {
        path: child.path,
        address: address,
        index: index
      };
    };

    TrezorBranch.prototype._processDetailsUpdate = function (details, handlers) {
      var self = this;

      // ignore pending balance details
      if (details.status === 'PENDING')
        return;

      // update the utxos
      this._utxos = this._constructUtxos(details, this.node.path);
      if (handlers.utxos) handlers.utxos(this._utxos);

      // load transactions
      this._backend.transactions(this.node)
        .then(function (res) {
          self._processTransactionsUpdate(res.data, handlers);
        });
    };

    TrezorBranch.prototype._processTransactionsUpdate = function (transactions, handlers) {
      // update the transactions
      this._transactions = this._constructTransactions(transactions, this.node.path);
      if (handlers.transactions) handlers.transactions(this._transactions);

      // update the offset
      this._offset = this._incrementOffset(this._transactions, this._offset || 0);

      // the subscription is considered initialized now
      this._subscriptionDfd.resolve();
    };

    TrezorBranch.prototype._constructUtxos = function (details, basePath) {
      // take the sum of all unspent outputs from the details
      return [details.confirmed, details.change, details.receiving]
        // concat to one list
        .reduce(function (utxos, x) { return utxos.concat(x); })
        // prepend basePath
        .map(function (utxo) {
          utxo.path = basePath.concat([utxo.addressId]);
          return utxo;
        });
    };

    TrezorBranch.prototype._constructTransactions = function (txs, basePath) {
      return txs.map(transaction);

      function transaction(tx) {
        var ret = new Bitcoin.Transaction({
          hash: tx.hash,
          version: tx.version,
          lock_time: tx.lockTime,
          timestamp: tx.height, // TODO: use tx.timestamp
          block: tx.blockHash
        });
        ret.ins = tx.inputs.map(input);
        ret.outs = tx.outputs.map(output);
        return ret;
      }

      function input(inp) {
        return new Bitcoin.TransactionIn({
          outpoint: {
            hash: inp.sourceHash,
            index: inp.ix
          },
          script: inp.script,
          sequence: inp.sequence
        });
      }

      function output(out) {
        return new TrezorTransactionOut({
          script: out.script,
          value: out.value.toString(),
          index: out.ix,
          path: out.addressId != null
            ? basePath.concat([out.addressId]) : null
        });
      }
    };

    TrezorBranch.prototype._incrementOffset = function (txs, offset) {
      txs.forEach(function (tx) {
        tx.outs
          .filter(function (out) { return out.path; })
          .forEach(function (out) {
            var id = out.path[out.path.length-1];
            if (id >= offset)
              offset = id + 1;
          });
      });
      return offset;
    };

    // Decorator around Bitcoin.Transaction, contains BIP32 index and path

    function TrezorTransactionOut(data) {
      Bitcoin.TransactionOut.call(this, data);
      this.index = data.index;
      this.path = data.path;
    }

    TrezorTransactionOut.prototype = Object.create(Bitcoin.TransactionOut.prototype);

    TrezorTransactionOut.prototype.clone = function () {
      var val = Bitcoin.TransactionOut.clone.call(this);
      val.index = this.index;
      val.path = this.path;
      return val;
    };

    return TrezorBranch;

  });