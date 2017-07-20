import BigNumber from 'bignumber.js';
import expectThrow from './helpers/expectThrow';
import time from './helpers/time';

const StoxSmartToken = artifacts.require('../contracts/StoxSmartToken.sol');
const StoxSmartTokenSaleMock = artifacts.require('./helpers/StoxSmartTokenSaleMock.sol');

contract('StoxSmartTokenSale', (accounts) => {
    const MINUTE = 60;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    const YEAR = 365 * DAY;

    const ETH = Math.pow(10, 18);
    const STX = Math.pow(10, 18);
    const DEFAULT_GAS_PRICE = 100000000000;

    const ETH_PRICE_USD = 227;
    const EXCHANGE_RATE = 200; // 200 STX for ETH
    const TOKEN_SALE_CAP = new BigNumber(30 * Math.pow(10, 6)).div(ETH_PRICE_USD).floor().mul(EXCHANGE_RATE).mul(STX);

    let waitUntilBlockNumber = async (blockNumber) => {
        console.log(`Mining until block: ${blockNumber}. Please wait for a couple of moments...`);
        while (web3.eth.blockNumber < blockNumber) {
            await time.mine();
        }
    }

    let blockNumber;
    let now;

    beforeEach(async () => {
        blockNumber = web3.eth.blockNumber;
        now = web3.eth.getBlock(blockNumber).timestamp;
    });

    describe('construction', async () => {
        let fundRecipient = accounts[8];
        let stoxRecipient = accounts[9];

        it('should be initialized with a valid funding recipient address', async () => {
            await expectThrow(StoxSmartTokenSaleMock.new(null, stoxRecipient, 10, 100));
        });

        it('should be initialized with a valid stox recipient address', async () => {
            await expectThrow(StoxSmartTokenSaleMock.new(fundRecipient, null, 10, 100));
        });

        it('should be initialized with a future starting block', async () => {
            await expectThrow(StoxSmartTokenSaleMock.new(fundRecipient, stoxRecipient, blockNumber - 1, blockNumber + 200));
        });

        it('should be initialized with a valid ending block', async () => {
            await expectThrow(StoxSmartTokenSaleMock.new(fundRecipient, stoxRecipient, blockNumber + 100, blockNumber - 1));
        });

        it('should deploy the StoxSmartToken contract and own it', async () => {
            let sale = await StoxSmartTokenSaleMock.new(fundRecipient, stoxRecipient, blockNumber + 100, blockNumber + 1000);
            let tokenAddress = await sale.stox();
            assert(tokenAddress != 0);

            let token = StoxSmartToken.at(await sale.stox());
            assert.equal(await token.owner(), sale.address);
        });

        it('should be initialized with 0 total sold tokens', async () => {
            let sale = await StoxSmartTokenSaleMock.new(fundRecipient, stoxRecipient, blockNumber + 100, blockNumber + 1000);
            assert.equal((await sale.tokensSold()), 0);
        });

        it('should be initialized as not finalized', async () => {
            let sale = await StoxSmartTokenSaleMock.new(fundRecipient, stoxRecipient, blockNumber + 100, blockNumber + 1000);
            assert.equal(await sale.isFinalized(), false);
        });

        it('should be ownable', async () => {
            let sale = await StoxSmartTokenSaleMock.new(fundRecipient, stoxRecipient, blockNumber + 100, blockNumber + 100000);
            assert.equal(await sale.owner(), accounts[0]);
        });
    });

    describe('finalize', async () => {
        let sale;
        let token;
        let start;
        let startFrom = 10;
        let end;
        let endTo = 20;
        let fundRecipient = accounts[8];
        let stoxRecipient = accounts[9];

        beforeEach(async () => {
            start = blockNumber + startFrom;
            end = blockNumber + endTo;
            sale = await StoxSmartTokenSaleMock.new(fundRecipient, stoxRecipient, start, end);
            token = StoxSmartToken.at(await sale.stox());
        });

        context('before the ending time', async() => {
            beforeEach(async () => {
                assert(blockNumber < end);
            });

            it('should throw', async () => {
                await expectThrow(sale.finalize());
            });
        });

        let testFinalization = async () => {
            it('should finalize the token sale', async () => {
                assert.equal((await sale.isFinalized()), false);

                await sale.finalize();

                assert.equal((await sale.isFinalized()), true);
            });

            it('should not allow to end a token sale when already ended', async () => {
                await sale.finalize();

                await expectThrow(sale.finalize());
            });
        }

        context('after the ending time', async() => {
            beforeEach(async () => {
                await waitUntilBlockNumber(end + 1);
                assert(web3.eth.blockNumber > end);
            });

            testFinalization();
        });

        context('reached token cap', async () => {
            beforeEach(async () => {
                await sale.setTokensSold(TOKEN_SALE_CAP.toNumber());
            });

            testFinalization();
        });
    });

    let verifyTransactions = async (sale, fundRecipient, stoxRecipient, method, transactions) => {
        let token = StoxSmartToken.at(await sale.stox());

        let totalTokensSold = new BigNumber(0);

        let i = 0;
        for (let t of transactions) {
            let tokens = new BigNumber(t.value.toString()).mul(EXCHANGE_RATE);

            console.log(`\t[${++i} / ${transactions.length}] expecting account ${t.from} to buy ` +
                `${tokens.toNumber() / STX} STX for ${t.value / ETH} ETH`);

            let fundRecipientETHBalance = web3.eth.getBalance(fundRecipient);
            let stoxRecipientSTXBalance = await token.balanceOf(stoxRecipient);
            let participantETHBalance = web3.eth.getBalance(t.from);
            let participantSTXBalance = await token.balanceOf(t.from);

            let tokensSold = await sale.tokensSold();
            assert.equal(totalTokensSold.toNumber(), tokensSold.toNumber());

            // Perform the transaction.
            let transaction = await method(sale, t.value, t.from);
            let gasUsed = DEFAULT_GAS_PRICE * transaction.receipt.gasUsed;

            let fundRecipientETHBalance2 = web3.eth.getBalance(fundRecipient);
            let stoxRecipientSTXBalance2 = await token.balanceOf(stoxRecipient);
            let participantETHBalance2 = web3.eth.getBalance(t.from);
            let participantSTXBalance2 = await token.balanceOf(t.from);

            totalTokensSold = totalTokensSold.plus(tokens);

            let tokensSold2 = await sale.tokensSold();
            assert.equal(tokensSold2.toNumber(), tokensSold.plus(tokens).toNumber());

            assert.equal(fundRecipientETHBalance2.toNumber(), fundRecipientETHBalance.plus(t.value.toString()).toNumber());
            assert.equal(stoxRecipientSTXBalance2.toNumber(), stoxRecipientSTXBalance.plus(tokens).toNumber());
            assert.equal(participantETHBalance2.toNumber(), participantETHBalance.minus(t.value.toString()).minus(gasUsed).toNumber());
            assert.equal(participantSTXBalance2.toNumber(), participantSTXBalance.plus(tokens).toNumber());
        }
    };

    let generateTokenTests = async (name, method) => {
        describe(name, async () => {
            let sale;
            let token;
            let fundRecipient = accounts[8];
            let stoxRecipient = accounts[9];
            let start;
            let startFrom = 10;
            let end;
            let endTo = 30;
            let value = 1000;

            beforeEach(async () => {
                start = blockNumber + startFrom;
                end = blockNumber + endTo;
                sale = await StoxSmartTokenSaleMock.new(fundRecipient, stoxRecipient, start, end);
                token = StoxSmartToken.at(await sale.stox());
            });

            context('after the ending time', async() => {
                beforeEach(async () => {
                    await waitUntilBlockNumber(end + 1);
                    assert(web3.eth.blockNumber > end);
                });

                it('should throw if called after the end fo the sale', async () => {
                    await expectThrow(method(sale, value));
                });
            });

            context('finalized', async () => {
                beforeEach(async () => {
                    await sale.setFinalized(true);

                    assert.equal(await sale.isFinalized(), true);
                });

                it('should not allow to end a token sale when already ended', async () => {
                    await expectThrow(method(sale, value));
                });
            });

            context('reached token cap', async () => {
                beforeEach(async () => {
                    await sale.setTokensSold(TOKEN_SALE_CAP.toNumber());
                    assert.equal((await sale.tokensSold()).toNumber(), TOKEN_SALE_CAP.toNumber());
                });

                it('should throw if reached token cap', async () => {
                    await expectThrow(method(sale, value));
                });
            });

            context('before the start of the sale', async() => {
                beforeEach(async () => {
                    assert(blockNumber < start);
                });

                it('should throw if called before the start fo the sale', async () => {
                    await expectThrow(method(sale, value));
                });
            });

            context('during the token sale', async () => {
                // Please note that we'd only have (end - start) blocks to run the tests below.
                beforeEach(async () => {
                    await waitUntilBlockNumber(start);
                    assert(web3.eth.blockNumber >= start);
                });

                it('should throw if called with 0 ETH', async () => {
                    await expectThrow(method(sale, 0));
                });

                [
                    [
                        { from: accounts[1], value: ETH },
                        { from: accounts[1], value: ETH },
                        { from: accounts[1], value: ETH },
                        { from: accounts[2], value: 150 * ETH }
                    ],
                    [
                        { from: accounts[1], value: ETH },
                        { from: accounts[2], value: 0.9 * ETH },
                        { from: accounts[3], value: 200 * ETH },
                        { from: accounts[2], value: 50 * ETH },
                        { from: accounts[4], value: 0.001 * ETH },
                        { from: accounts[5], value: 12.25 * ETH },
                        { from: accounts[2], value: 0.11 * ETH },
                        { from: accounts[2], value: 15000 * ETH },
                        { from: accounts[1], value: 1.01 * ETH }
                    ],
                    [
                        { from: accounts[1], value: 5 * ETH },
                        { from: accounts[2], value: 300 * ETH },
                        { from: accounts[2], value: 300 * ETH },
                        { from: accounts[2], value: ETH },
                        { from: accounts[4], value: 1000 * ETH },
                        { from: accounts[5], value: 1.91 * ETH },
                        { from: accounts[2], value: 0.1 * ETH },
                        { from: accounts[2], value: 600 * ETH },
                        { from: accounts[1], value: 0.03 * ETH }
                    ],
                    [
                        { from: accounts[3], value: TOKEN_SALE_CAP / STX / EXCHANGE_RATE / 4 * ETH },
                        { from: accounts[3], value: TOKEN_SALE_CAP / STX / EXCHANGE_RATE / 4 * ETH },
                        { from: accounts[3], value: TOKEN_SALE_CAP / STX / EXCHANGE_RATE / 4 * ETH },
                        { from: accounts[3], value: TOKEN_SALE_CAP / STX / EXCHANGE_RATE / 4 * ETH }
                    ],
                    [
                        { from: accounts[3], value: (TOKEN_SALE_CAP / STX / EXCHANGE_RATE * ETH) + 1000 }
                    ]
                ].forEach((transactions) => {
                    context(`${JSON.stringify(transactions).slice(0, 200)}...`, async function() {
                        // These are long tests, so we need to  disable timeouts.
                        this.timeout(0);

                        it('should execute sale orders', async () => {
                            await verifyTransactions(sale, fundRecipient, stoxRecipient, method, transactions);
                        });
                    });
                });
            });
        });
    }

    // Generate tests which check the "create" method.
    generateTokenTests('using the create function', async (sale, value, from) => {
        let account = from || accounts[0];
        return sale.create(account, {value: value, from: account});
    });

    // Generate tests which check the contract's fallback method.
    generateTokenTests('using fallback function', async (sale, value, from) => {
        if (from) {
            return sale.sendTransaction({value: value, from: from});
        }

        return sale.send(value);
    });
});