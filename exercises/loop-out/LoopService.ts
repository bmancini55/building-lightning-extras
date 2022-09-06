import crypto from "crypto";
import * as Bitcoin from "@node-lightning/bitcoin";
import { BitcoindClient, Transaction } from "@node-lightning/bitcoind";
import { ClientFactory } from "../../shared/ClientFactory";
import { ILndClient } from "../../shared/data/lnd/ILndClient";
import { Lnd } from "../../shared/data/lnd/v0.12.1-beta/Types";
import { sha256 } from "../../shared/Sha256";
import { OutPoint, Tx } from "@node-lightning/bitcoin";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class LoopService {
    public lightning: ILndClient;
    public bitcoind: BitcoindClient;

    async start() {
        // Constructs a LND client from the environment variables
        this.lightning = await ClientFactory.lndFromEnv();

        // Construct bitcoind client
        this.bitcoind = new BitcoindClient({
            host: "127.0.0.1",
            port: 18443,
            rpcuser: "polaruser",
            rpcpassword: "polarpass",
            zmqpubrawblock: "tcp://127.0.0.1:28334",
            zmqpubrawtx: "tcp://127.0.0.1:29335",
        });
    }

    public async generateInvoice(hash: Buffer, value: number) {
        const invoice = await this.lightning.addHoldInvoice({
            hash: hash,
            value: value.toString(),
            cltv_expiry: "80",
        });
        return invoice;
    }

    public async waitForInvoicePayment(hash: Buffer): Promise<Lnd.Invoice> {
        return new Promise(resolve => {
            this.lightning.subscribeSingleInvoice({ r_hash: hash }, invoice => {
                console.log(invoice.r_hash.toString("hex"), invoice.state);
                if (invoice.state === "ACCEPTED") {
                    console.log("invoice paid, you may proceed");
                    resolve(invoice);
                }
            });
        });
    }

    public async createOnChainHtlc(
        hash: Buffer,
        amount: Bitcoin.Value,
        theirAddress: string,
        ourKey: Bitcoin.PrivateKey,
        utxo: Bitcoin.OutPoint,
    ) {
        const utxoInfo = await this.bitcoind.getUtxo(utxo.txid.toString(), utxo.outputIndex);
        const utxoValue = Bitcoin.Value.fromBitcoin(utxoInfo.value);

        const ourPubKey = ourKey.toPubKey(true);

        const theirAddressDecoded = Bitcoin.Address.decodeBech32(theirAddress);

        const txBuilder = new Bitcoin.TxBuilder();
        txBuilder.addInput(utxo, Bitcoin.Sequence.rbf());

        // add the change output
        const fees = Bitcoin.Value.fromSats(3000); // use a fixed fee for simplicity
        const changeOutput = utxoValue.clone();
        changeOutput.sub(amount);
        changeOutput.sub(fees);
        const changeScriptPubKey = Bitcoin.Script.p2wpkhLock(ourPubKey.toBuffer());
        txBuilder.addOutput(changeOutput, changeScriptPubKey);

        // add the amount output
        const htlcScriptPubKey = new Bitcoin.Script(
            Bitcoin.OpCode.OP_SHA256,
            hash,
            Bitcoin.OpCode.OP_EQUAL,
            Bitcoin.OpCode.OP_IF,
                Bitcoin.OpCode.OP_DUP,
                Bitcoin.OpCode.OP_HASH160,
                theirAddressDecoded.program,
            Bitcoin.OpCode.OP_ELSE,
                Bitcoin.Script.number(20),
                Bitcoin.OpCode.OP_CHECKSEQUENCEVERIFY,
                Bitcoin.OpCode.OP_DROP,
                Bitcoin.OpCode.OP_DUP,
                Bitcoin.OpCode.OP_HASH160,
                ourPubKey.hash160(),  // technically should go to htlc pubkey
            Bitcoin.OpCode.OP_ENDIF,
            Bitcoin.OpCode.OP_EQUALVERIFY,
            Bitcoin.OpCode.OP_CHECKSIG,
        ); // prettier-ignore
        txBuilder.addOutput(amount, Bitcoin.Script.p2wshLock(htlcScriptPubKey));
        txBuilder.locktime = Bitcoin.LockTime.zero();

        txBuilder.addWitness(
            0,
            txBuilder.signSegWitv0(
                0,
                Bitcoin.Script.p2pkhLock(ourPubKey.toBuffer()),
                ourKey.toBuffer(),
                utxoValue,
            ),
        );
        txBuilder.addWitness(0, ourPubKey.toBuffer());

        return txBuilder.toTx();
    }

    public async sendTx(tx: Tx): Promise<string> {
        return await this.bitcoind.sendRawTransaction(tx.toHex());
    }

    public async waitForHtlcSpend(outpoint: OutPoint): Promise<Buffer> {
        let lastHash: string = await this.bitcoind.getBestBlockHash();
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const bestHash = await this.bitcoind.getBestBlockHash();
            if (bestHash !== lastHash) {
                console.log("block", bestHash);
                const block = await this.bitcoind.getBlock(bestHash);
                lastHash = block.hash;
                // should handle chain reorgs
                for (const tx of block.tx) {
                    for (const input of tx.vin) {
                        // we have a match!
                        if (
                            input.txid === outpoint.txid.toString(Bitcoin.HashByteOrder.RPC) &&
                            input.vout === outpoint.outputIndex
                        ) {
                            // extract preimage
                            const witness = Buffer.from(input.txinwitness[2], "hex");
                            return witness;
                        }
                    }
                }
            }
            await wait(5000); // try every 5 seconds
        }
    }

    public async settleInvoice(preimage: Buffer): Promise<void> {
        await this.lightning.settleInvoice(preimage);
    }
}

async function run() {
    const service = new LoopService();
    await service.start();

    // Prereqs:
    // Hash
    // Private key of funds of funds

    // Bob creates hash and provides a pubkey where she wants funds
    // Alice generates an invoice for the hash and we spit this out
    // Bob pays invoices
    // Alice upon receipt of payment creates HTLC tx and pays it
    // Alice watches output to look for payment
    // Bob pays the transaction
    // Alice sees the HTLC payment and settles online

    const hash = Buffer.from(process.argv[2], "hex");
    console.log("hash", hash.toString("hex"));

    console.log(process.argv);
    const satoshis = Bitcoin.Value.fromSats(Number(process.argv[3]));
    console.log("satoshis", satoshis);

    //
    const ourPrivKey = new Bitcoin.PrivateKey(
        Buffer.from(process.argv[4], "hex"),
        Bitcoin.Network.regtest,
    );
    console.log("our address", ourPrivKey.toPubKey(true).toP2wpkhAddress());

    // get the source of our funds
    const utxo = Bitcoin.OutPoint.fromString(process.argv[5]);

    // their address
    const theirAddress = process.argv[6];
    console.log("their address", theirAddress);

    const invoice = await service.generateInvoice(hash, Number(satoshis.sats));
    console.log("they need to pay this invoice", invoice);

    // wait for the invoice to be paid
    await service.waitForInvoicePayment(hash);
    console.log("invoice has been paid");

    // construct and broadcast tx
    const tx = await service.createOnChainHtlc(hash, satoshis, theirAddress, ourPrivKey, utxo);
    const htlcTxId = await service.sendTx(tx);
    console.log("broadcast txid", htlcTxId);
    console.log("they should utxo", htlcTxId + ":1");

    // wait for spend
    const htlcOutpoint = new Bitcoin.OutPoint(htlcTxId, 1);
    const foundPreimage = await service.waitForHtlcSpend(htlcOutpoint);

    console.log("received preimage", foundPreimage.toString("hex"));

    if (foundPreimage.length) {
        service.settleInvoice(foundPreimage);
        console.log("complete");
    }
}

run().catch(console.error);