/**
 * @title MobileMoneyProvider Unit Tests
 * @description Tests for Sonatel mobile money provider with Senegal phone validation & daily limits
 */
import { expect } from "chai";
import hre from "hardhat";

const { ethers } = await hre.network.connect();

describe("MobileMoneyProvider", function () {
    let sonatel;
    let owner, relayer1, relayer2, beneficiary, other;

    const VALID_PHONE = "+221771234567"; // Orange Money (77)
    const WAVE_PHONE = "+221761234567"; // Wave (76)
    const AMOUNT = 5000; // 5000 CFA (plain integer, no 1e18 scaling)
    const REGION = "SN-TH";

    // Phone hash constants (V-04: PII off-chain)
    const VALID_PHONE_HASH = ethers.keccak256(ethers.toUtf8Bytes(VALID_PHONE));
    const WAVE_PHONE_HASH = ethers.keccak256(ethers.toUtf8Bytes(WAVE_PHONE));
    const INVALID_PHONE_HASH = ethers.keccak256(ethers.toUtf8Bytes("+33612345678"));

    // Helper: generate a bytes32 beneficiary hash
    function beneficiaryHash(label) {
        return ethers.keccak256(ethers.toUtf8Bytes(label));
    }

    const HASH_A = ethers.keccak256(ethers.toUtf8Bytes("beneficiary-A"));
    const HASH_B = ethers.keccak256(ethers.toUtf8Bytes("beneficiary-B"));

    beforeEach(async function () {
        [owner, relayer1, relayer2, beneficiary, other] = await ethers.getSigners();

        const Sonatel = await ethers.getContractFactory("MobileMoneyProvider");
        sonatel = await Sonatel.deploy();
        await sonatel.waitForDeployment();

        // Add a relayer
        await sonatel.addRelayer(relayer1.address);
    });

    // =========================================================================
    //                         DEPLOYMENT
    // =========================================================================
    describe("Deployment", function () {
        it("should set correct owner", async function () {
            expect(await sonatel.owner()).to.equal(owner.address);
        });

        it("should not be paused", async function () {
            expect(await sonatel.paused()).to.be.false;
        });

        it("should have default timeout of 30 minutes", async function () {
            expect(await sonatel.paymentTimeout()).to.equal(30 * 60);
        });

        it("should start with 0 total payments", async function () {
            expect(await sonatel.totalPaymentsInitiated()).to.equal(0);
        });
    });

    // =========================================================================
    //                      RELAYER MANAGEMENT
    // =========================================================================
    describe("Relayer Management", function () {
        it("should add a relayer", async function () {
            await expect(sonatel.addRelayer(relayer2.address))
                .to.emit(sonatel, "RelayerAdded")
                .withArgs(relayer2.address);
            expect(await sonatel.authorizedRelayers(relayer2.address)).to.be.true;
        });

        it("should remove a relayer", async function () {
            await expect(sonatel.removeRelayer(relayer1.address))
                .to.emit(sonatel, "RelayerRemoved")
                .withArgs(relayer1.address);
            expect(await sonatel.authorizedRelayers(relayer1.address)).to.be.false;
        });

        it("should revert adding zero address", async function () {
            await expect(
                sonatel.addRelayer(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(sonatel, "ZeroAddress");
        });

        it("should silently overwrite when adding existing relayer", async function () {
            // addRelayer does not check for duplicates
            await sonatel.addRelayer(relayer1.address);
            expect(await sonatel.authorizedRelayers(relayer1.address)).to.be.true;
        });

        it("should revert if not owner", async function () {
            await expect(
                sonatel.connect(other).addRelayer(relayer2.address)
            ).to.be.revertedWithCustomError(sonatel, "OwnableUnauthorizedAccount");
        });
    });

    // =========================================================================
    //                  PAYMENT INITIATION
    // =========================================================================
    describe("Payment Initiation", function () {
        it("should initiate payment with valid Senegal phone", async function () {
            const tx = await sonatel.connect(relayer1).initiatePayment(
                HASH_A, AMOUNT, VALID_PHONE_HASH, REGION, 0
            );
            await expect(tx).to.emit(sonatel, "PaymentInitiated");
        });

        it("should revert for invalid phone hash (zero bytes32)", async function () {
            await expect(
                sonatel.connect(relayer1).initiatePayment(
                    HASH_A, AMOUNT, ethers.ZeroHash, REGION, 0
                )
            ).to.be.revertedWithCustomError(sonatel, "EmptyPhone");
        });

        it("should revert for amount below minimum (500 CFA)", async function () {
            const tooSmall = 100;
            await expect(
                sonatel.connect(relayer1).initiatePayment(
                    HASH_A, tooSmall, VALID_PHONE_HASH, REGION, 0
                )
            ).to.be.revertedWithCustomError(sonatel, "InvalidAmount");
        });

        it("should revert for amount above maximum (5_000_000 CFA)", async function () {
            const tooLarge = 5_000_001;
            await expect(
                sonatel.connect(relayer1).initiatePayment(
                    HASH_A, tooLarge, VALID_PHONE_HASH, REGION, 0
                )
            ).to.be.revertedWithCustomError(sonatel, "InvalidAmount");
        });

        it("should revert if not relayer", async function () {
            await expect(
                sonatel.connect(other).initiatePayment(
                    HASH_A, AMOUNT, VALID_PHONE_HASH, REGION, 0
                )
            ).to.be.revertedWithCustomError(sonatel, "UnauthorizedRelayer");
        });

        it("should revert when paused", async function () {
            await sonatel.pause();
            await expect(
                sonatel.connect(relayer1).initiatePayment(
                    HASH_A, AMOUNT, VALID_PHONE_HASH, REGION, 0
                )
            ).to.be.revertedWithCustomError(sonatel, "EnforcedPause");
        });

        it("should increment total payments", async function () {
            await sonatel.connect(relayer1).initiatePayment(
                HASH_A, AMOUNT, VALID_PHONE_HASH, REGION, 0
            );
            expect(await sonatel.totalPaymentsInitiated()).to.equal(1);
        });
    });

    // =========================================================================
    //               PAYMENT LIFECYCLE (CONFIRM / FAIL / RETRY)
    // =========================================================================
    describe("Payment Lifecycle", function () {
        let paymentId;

        beforeEach(async function () {
            const tx = await sonatel.connect(relayer1).initiatePayment(
                HASH_A, AMOUNT, VALID_PHONE_HASH, REGION, 0
            );
            const receipt = await tx.wait();
            const log = receipt.logs.find(
                l => l.fragment && l.fragment.name === "PaymentInitiated"
            );
            paymentId = log.args[0];
        });

        it("should confirm payment", async function () {
            const txRef = "SONATEL-TX-001";
            await expect(sonatel.connect(relayer1).confirmPayment(paymentId, txRef))
                .to.emit(sonatel, "PaymentConfirmed");
        });

        it("should fail payment", async function () {
            await expect(sonatel.connect(relayer1).failPayment(paymentId, "Timeout"))
                .to.emit(sonatel, "PaymentFailed")
                .withArgs(paymentId, "Timeout");
        });

        it("should retry failed payment", async function () {
            await sonatel.connect(relayer1).failPayment(paymentId, "Network error");
            await expect(sonatel.connect(relayer1).retryPayment(paymentId))
                .to.emit(sonatel, "PaymentRetried");
        });

        it("should not retry beyond MAX_RETRIES (3)", async function () {
            // Need 3 full fail+retry cycles to reach retryCount=3
            for (let i = 0; i < 3; i++) {
                await sonatel.connect(relayer1).failPayment(paymentId, `fail-${i}`);
                await sonatel.connect(relayer1).retryPayment(paymentId);
            }
            // retryCount is now 3, fail once more then retry should revert
            await sonatel.connect(relayer1).failPayment(paymentId, "final-fail");
            await expect(
                sonatel.connect(relayer1).retryPayment(paymentId)
            ).to.be.revertedWithCustomError(sonatel, "MaxRetriesExceeded");
        });

        it("should auto-expire on confirm after timeout", async function () {
            // Advance past 30 min timeout
            await ethers.provider.send("evm_increaseTime", [31 * 60]);
            await ethers.provider.send("evm_mine", []);

            // Confirm should revert with PaymentExpiredError
            await expect(
                sonatel.connect(relayer1).confirmPayment(paymentId, "late-tx")
            ).to.be.revertedWithCustomError(sonatel, "PaymentExpiredError");
        });

        it("should re-reserve regionDailySpend under the retry day when retryPayment crosses a day boundary", async function () {
            const limit = AMOUNT;
            await sonatel.setDailyLimit(REGION, limit);

            await sonatel.connect(relayer1).failPayment(paymentId, "Network error");

            // Advance into the next UTC day bucket (block.timestamp / 1 days)
            await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
            await ethers.provider.send("evm_mine", []);

            await sonatel.connect(relayer1).retryPayment(paymentId);

            // The retried payment now reserves today's allowance again
            await expect(
                sonatel.connect(relayer1).initiatePayment(HASH_B, AMOUNT, WAVE_PHONE_HASH, REGION, 0)
            ).to.be.revertedWithCustomError(sonatel, "DailyLimitExceeded");
        });
    });

    // =========================================================================
    //                    BATCH OPERATIONS
    // =========================================================================
    describe("Batch Operations", function () {
        it("should batch initiate payments", async function () {
            // batchInitiatePayments(bytes32[], uint256[], bytes32[], string region)
            const hashes = [HASH_A, HASH_B];
            const amounts = [AMOUNT, AMOUNT];
            const phones = [VALID_PHONE_HASH, WAVE_PHONE_HASH];

            const tx = await sonatel.connect(relayer1).batchInitiatePayments(
                hashes, amounts, phones, REGION, [0, 0]
            );
            expect(await sonatel.totalPaymentsInitiated()).to.equal(2);
        });

        it("should revert batch > MAX_BATCH_SIZE (100)", async function () {
            const hashes = new Array(101).fill(HASH_A);
            const amounts = new Array(101).fill(AMOUNT);
            const phones = new Array(101).fill(VALID_PHONE_HASH);

            await expect(
                sonatel.connect(relayer1).batchInitiatePayments(
                    hashes, amounts, phones, REGION, new Array(101).fill(0)
                )
            ).to.be.revertedWithCustomError(sonatel, "BatchTooLarge");
        });

        it("should revert batch with mismatched arrays", async function () {
            await expect(
                sonatel.connect(relayer1).batchInitiatePayments(
                    [HASH_A],
                    [AMOUNT, AMOUNT],
                    [VALID_PHONE_HASH],
                    REGION,
                    [0]
                )
            ).to.be.revertedWithCustomError(sonatel, "ArrayLengthMismatch");
        });

        it("should batch confirm payments", async function () {
            // Initiate 2 individual payments to get paymentIds
            const tx1 = await sonatel.connect(relayer1).initiatePayment(
                HASH_A, AMOUNT, VALID_PHONE_HASH, REGION, 0
            );
            const tx2 = await sonatel.connect(relayer1).initiatePayment(
                HASH_B, AMOUNT, WAVE_PHONE_HASH, "SN-DK", 0
            );

            const r1 = await tx1.wait();
            const r2 = await tx2.wait();
            const id1 = r1.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated").args[0];
            const id2 = r2.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated").args[0];

            await sonatel.connect(relayer1).batchConfirmPayments(
                [id1, id2],
                ["TX-A", "TX-B"]
            );
        });

        it("should refund regionDailySpend when batchConfirmPayments expires a stale payment", async function () {
            const limit = AMOUNT;
            await sonatel.setDailyLimit(REGION, limit);

            const tx = await sonatel.connect(relayer1).initiatePayment(
                HASH_A, AMOUNT, VALID_PHONE_HASH, REGION, 0
            );
            const receipt = await tx.wait();
            const paymentId = receipt.logs.find(
                l => l.fragment && l.fragment.name === "PaymentInitiated"
            ).args[0];

            // Advance past timeout
            await ethers.provider.send("evm_increaseTime", [31 * 60]);
            await ethers.provider.send("evm_mine", []);

            await sonatel.connect(relayer1).batchConfirmPayments([paymentId], ["late-tx"]);

            const payment = await sonatel.getPayment(paymentId);
            expect(payment.status).to.equal(3); // EXPIRED

            // The refunded allowance should now permit a new payment
            await expect(
                sonatel.connect(relayer1).initiatePayment(HASH_B, AMOUNT, WAVE_PHONE_HASH, REGION, 0)
            ).to.not.revert(ethers);
        });
    });

    // =========================================================================
    //                     DAILY LIMITS
    // =========================================================================
    describe("Daily Limits", function () {
        it("should set daily limit for a region", async function () {
            const limit = 1000000;
            await sonatel.setDailyLimit(REGION, limit);
            expect(await sonatel.regionDailyLimit(REGION)).to.equal(limit);
        });

        it("should revert exceeding daily limit", async function () {
            const limit = 6000;
            await sonatel.setDailyLimit(REGION, limit);

            // First payment: 5000 - should pass
            await sonatel.connect(relayer1).initiatePayment(
                HASH_A, AMOUNT, VALID_PHONE_HASH, REGION, 0
            );

            // Second payment: 5000 - should exceed 6000 limit
            await expect(
                sonatel.connect(relayer1).initiatePayment(
                    HASH_B, AMOUNT, WAVE_PHONE_HASH, REGION, 0
                )
            ).to.be.revertedWithCustomError(sonatel, "DailyLimitExceeded");
        });

        it("should revert if not owner setting limits", async function () {
            await expect(
                sonatel.connect(other).setDailyLimit(REGION, 100000)
            ).to.be.revertedWithCustomError(sonatel, "OwnableUnauthorizedAccount");
        });
    });

    // =========================================================================
    //                  TIMEOUT MANAGEMENT
    // =========================================================================
    describe("Timeout Management", function () {
        it("should update timeout", async function () {
            await sonatel.setTimeout(3600); // 1 hour
            expect(await sonatel.paymentTimeout()).to.equal(3600);
        });

        it("should revert timeout < MIN_TIMEOUT (5 min)", async function () {
            await expect(
                sonatel.setTimeout(200)
            ).to.be.revertedWithCustomError(sonatel, "InvalidTimeout");
        });

        it("should revert timeout > MAX_TIMEOUT (24h)", async function () {
            await expect(
                sonatel.setTimeout(25 * 3600)
            ).to.be.revertedWithCustomError(sonatel, "InvalidTimeout");
        });
    });

    // =========================================================================
    //                   EXPIRE STALE PAYMENTS
    // =========================================================================
    describe("Expire Stale Payments", function () {
        it("should expire stale payments", async function () {
            const tx = await sonatel.connect(relayer1).initiatePayment(
                HASH_A, AMOUNT, VALID_PHONE_HASH, REGION, 0
            );
            const receipt = await tx.wait();
            const paymentId = receipt.logs.find(
                l => l.fragment && l.fragment.name === "PaymentInitiated"
            ).args[0];

            // Advance past timeout
            await ethers.provider.send("evm_increaseTime", [31 * 60]);
            await ethers.provider.send("evm_mine", []);

            await sonatel.expireStalePayments([paymentId]);
        });

        it("should refund regionDailySpend when expireStalePayments expires a payment", async function () {
            const limit = AMOUNT;
            await sonatel.setDailyLimit(REGION, limit);

            const tx = await sonatel.connect(relayer1).initiatePayment(
                HASH_A, AMOUNT, VALID_PHONE_HASH, REGION, 0
            );
            const receipt = await tx.wait();
            const paymentId = receipt.logs.find(
                l => l.fragment && l.fragment.name === "PaymentInitiated"
            ).args[0];

            // Daily allowance is now fully reserved
            await expect(
                sonatel.connect(relayer1).initiatePayment(HASH_B, AMOUNT, WAVE_PHONE_HASH, REGION, 0)
            ).to.be.revertedWithCustomError(sonatel, "DailyLimitExceeded");

            // Advance past timeout and expire the stale payment
            await ethers.provider.send("evm_increaseTime", [31 * 60]);
            await ethers.provider.send("evm_mine", []);
            await sonatel.expireStalePayments([paymentId]);

            const payment = await sonatel.getPayment(paymentId);
            expect(payment.status).to.equal(3); // EXPIRED

            // The refunded allowance should now permit a new payment
            await expect(
                sonatel.connect(relayer1).initiatePayment(HASH_B, AMOUNT, WAVE_PHONE_HASH, REGION, 0)
            ).to.not.revert(ethers);
        });
    });

    // =========================================================================
    //                    PAUSE / UNPAUSE
    // =========================================================================
    describe("Pause / Unpause", function () {
        it("should pause", async function () {
            await sonatel.pause();
            expect(await sonatel.paused()).to.be.true;
        });

        it("should unpause", async function () {
            await sonatel.pause();
            await sonatel.unpause();
            expect(await sonatel.paused()).to.be.false;
        });

        it("should revert if not owner", async function () {
            await expect(
                sonatel.connect(other).pause()
            ).to.be.revertedWithCustomError(sonatel, "OwnableUnauthorizedAccount");
        });
    });
});
