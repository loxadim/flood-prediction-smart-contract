/**
 * BatchBeneficiaries1000.test.js — Large Batch Performance Test
 * DPA Foundation — OPAL Platform
 * 
 * Tests batch payment processing at scale to ensure
 * gas limits and data structures hold up to real-world usage.
 */

import { expect } from "chai";
import hre from "hardhat";
import { MerkleTree } from "merkletreejs";
import { createRequire } from "module";
import { upgrades as makeUpgrades } from "@openzeppelin/hardhat-upgrades";
const require = createRequire(import.meta.url);
const keccak256 = require("keccak256");

const connection = await hre.network.connect();
const { ethers } = connection;
const ozUpgrades = await makeUpgrades(hre, connection);

describe("Batch Beneficiaries — Scale Tests", function () {
    let floodPrediction, multiOracle, jokalante, mobileMoney, opalGov;
    let admin, operator, upgrader, pauser;
    let beneficiaries, leaves, tree, merkleRoot;
    // A8-13 fix: KYC compliance and the ARCH-01 ledger binding were both absent from this
    // file, so every gas figure it produced described a configuration nobody deploys.
    // batchCheckCompliance() and the per-item getPaymentRecord() callback together add
    // roughly 16 % to the cost of a batch. The contract is deployed once and reused: the
    // beneficiary hashes are deterministic, so attestations approved here survive each
    // redeployment of the hub, and per-test isolation is untouched.
    let kyc, kycAddress;

    const OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
    const TOTAL_BENEFICIARIES = 1000;
    const BATCH_SIZE = 50;
    const AMOUNT = 5000;

    // Generate N beneficiaries with proper Merkle leaf format:
    // leaf = keccak256(abi.encode(bytes32 hash, uint256 amount))
    function generateBeneficiaries(count) {
        const bens = [];
        for (let i = 0; i < count; i++) {
            bens.push({
                hash: ethers.keccak256(
                    ethers.AbiCoder.defaultAbiCoder().encode(
                        ["string", "uint256"],
                        [`beneficiary_${i}`, i]
                    )
                ),
                amount: 5000
            });
        }
        return bens;
    }

    function buildMerkleTree(bens) {
        const leavesArr = bens.map(b =>
            ethers.keccak256(
                ethers.keccak256(
                    ethers.AbiCoder.defaultAbiCoder().encode(
                        ["bytes32", "uint256"],
                        [b.hash, b.amount]
                    )
                )
            )
        );
        const treeObj = new MerkleTree(leavesArr, keccak256, { sortPairs: true });
        return { tree: treeObj, leaves: leavesArr, root: treeObj.getHexRoot() };
    }

    // A8-13 fix: one KYC deployment, one approval pass, reused by every test below.
    before(async function () {
        this.timeout(300000);
        const signers = await ethers.getSigners();
        const [officerA, officerB] = [signers[4], signers[5]];

        const KYC = await ethers.getContractFactory("KYCAMLCompliance");
        kyc = await KYC.deploy();
        await kyc.waitForDeployment();
        kycAddress = await kyc.getAddress();

        // Two officers: approveAttestation enforces the four-eyes rule, so the approver
        // must differ from the submitter (H-04).
        await kyc.addComplianceOfficer(officerA.address);
        await kyc.addComplianceOfficer(officerB.address);

        for (const b of generateBeneficiaries(1000)) {
            await kyc.connect(officerA).submitAttestation(
                b.hash,
                ethers.keccak256(ethers.toUtf8Bytes("identity" + b.hash)),
                ethers.keccak256(ethers.toUtf8Bytes("documents")),
                "SN-TH"
            );
            await kyc.connect(officerB).approveAttestation(b.hash, 0, 0);
        }
    });

    beforeEach(async function () {
        [admin, operator, upgrader, pauser] = await ethers.getSigners();

        const MultiOracle = await ethers.getContractFactory("MultiOracle");
        multiOracle = await MultiOracle.deploy();
        await multiOracle.waitForDeployment();

        const Jokalante = await ethers.getContractFactory("JokalanteTargeting");
        jokalante = await Jokalante.deploy();
        await jokalante.waitForDeployment();

        const MobileMoney = await ethers.getContractFactory("MobileMoneyProvider");
        mobileMoney = await MobileMoney.deploy();
        await mobileMoney.waitForDeployment();

        const OpalGov = await ethers.getContractFactory("OpalGovernanceUpgradeable");
        opalGov = await ozUpgrades.deployProxy(OpalGov, [admin.address, 2], { kind: "uups" });
        await opalGov.waitForDeployment();

        const FloodPred = await ethers.getContractFactory("FloodPredictionContract");
        floodPrediction = await ozUpgrades.deployProxy(FloodPred, [admin.address, operator.address, upgrader.address, pauser.address], { kind: "uups" });
        await floodPrediction.waitForDeployment();

        // A8-13 fix: the KYC module is wired in, so batchCheckCompliance() runs on every
        // batch exactly as it does in production.
        await floodPrediction.setContractAddresses(
            await multiOracle.getAddress(),
            await opalGov.getAddress(),
            await jokalante.getAddress(),
            await mobileMoney.getAddress(),
            kycAddress
        );

        await floodPrediction.grantRole(OPERATOR_ROLE, operator.address);
        await floodPrediction.allocateBudget("SN-TH", 100_000_000n);

        // Register FloodPrediction as relayer on MobileMoneyProvider
        await mobileMoney.addRelayer(await floodPrediction.getAddress());
        // A8-13 fix: bind the payment rail to the ledger (ARCH-01). Each item in a batch
        // then costs an extra getPaymentRecord() callback into the hub — a real cost the
        // deployment scripts always incur and this file used to omit.
        await mobileMoney.setFloodPredictionContract(await floodPrediction.getAddress());
        // Daily ceiling set to the region's allocation, as deploy-amoy.js does.
        await mobileMoney.setDailyLimit("SN-TH", 100_000_000n);
        // Authorize the freshly deployed hub to read compliance from the shared registry.
        await kyc.authorizeContract(await floodPrediction.getAddress());

        // Generate 1000 beneficiaries with correct leaf format
        beneficiaries = generateBeneficiaries(1000);
        const mt = buildMerkleTree(beneficiaries);
        tree = mt.tree;
        leaves = mt.leaves;
        merkleRoot = mt.root;

        // Activate region in JokalanteTargeting
        await jokalante.updateMerkleRoot("SN-TH", merkleRoot, 1000);
        await jokalante.addAuthorizedCaller(await floodPrediction.getAddress());
    });

    describe("Merkle Tree — 1000 Beneficiaries", function () {
        it("should generate valid Merkle root from 1000 leaves", function () {
            expect(merkleRoot).to.not.equal(ethers.ZeroHash);
            expect(tree.getLeafCount()).to.equal(1000);
        });

        it("should verify Merkle proofs for random beneficiaries", function () {
            const indices = [0, 99, 250, 499, 500, 750, 999, 42, 888, 137];
            for (const idx of indices) {
                const proof = tree.getProof(leaves[idx]);
                expect(tree.verify(proof, leaves[idx], tree.getRoot())).to.be.true;
            }
        });

        it("should reject invalid proofs", function () {
            const fakeLeaf = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ["bytes32", "uint256"],
                    [ethers.keccak256(ethers.toUtf8Bytes("fake")), 99999]
                )
            );
            const proof = tree.getProof(leaves[0]);
            expect(tree.verify(proof, fakeLeaf, tree.getRoot())).to.be.false;
        });
    });

    describe("Batch Payment — MAX_BATCH_SIZE (50)", function () {
        let eventId;

        beforeEach(async function () {
            const tx = await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 250000, 50  // 50 beneficiaries × 5000 FCFA each
            );
            await tx.wait();
            eventId = (await floodPrediction.getTriggerIds())[0];
            await floodPrediction.connect(operator).validateTrigger(eventId);
        });

        it("should process a full batch of 50 beneficiaries", async function () {
            const hashes = [];
            const amounts = [];
            const proofs = [];
            const phoneNumbers = [];

            for (let i = 0; i < 50; i++) {
                hashes.push(beneficiaries[i].hash);
                amounts.push(beneficiaries[i].amount);
                proofs.push(
                    tree.getProof(leaves[i]).map(p => "0x" + p.data.toString("hex"))
                );
                phoneNumbers.push(ethers.keccak256(ethers.toUtf8Bytes(`+22177000${String(i).padStart(4, "0")}`)));
            }

            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    eventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)
                )
            ).to.not.revert(ethers);

            for (let i = 0; i < 50; i++) {
                expect(await floodPrediction.isBeneficiaryPaid(eventId, hashes[i])).to.be.true;
            }
        });

        it("should reject batch exceeding MAX_BATCH_SIZE", async function () {
            const hashes = [];
            const amounts = [];
            const proofs = [];
            const phoneNumbers = [];

            for (let i = 0; i < 51; i++) {
                hashes.push(beneficiaries[i].hash);
                amounts.push(beneficiaries[i].amount);
                proofs.push([]);
                phoneNumbers.push(ethers.keccak256(ethers.toUtf8Bytes(`+22177000${String(i).padStart(4, "0")}`)));
            }

            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    eventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)
                )
            ).to.be.revertedWithCustomError(floodPrediction, "InvalidBatchSize");
        });

        it("should process sequential batches across 4 regions covering 200 beneficiaries", async function () {
            const regions = ["SN-DK", "SN-SL", "SN-ZG", "SN-KL"];
            let totalPaid = 0;

            for (let batch = 0; batch < 4; batch++) {
                await floodPrediction.allocateBudget(regions[batch], 100_000_000n);
                await jokalante.updateMerkleRoot(regions[batch], merkleRoot, 1000);

                await floodPrediction.connect(operator).createFloodTrigger(
                    regions[batch], 85, merkleRoot, 250000, 50
                );
                const ids = await floodPrediction.getTriggerIds();
                const batchEventId = ids[ids.length - 1];
                await floodPrediction.connect(operator).validateTrigger(batchEventId);

                const hashes = [];
                const amounts = [];
                const proofs = [];
                const phoneNumbers = [];

                for (let i = 0; i < 50; i++) {
                    const idx = batch * 50 + i;
                    hashes.push(beneficiaries[idx].hash);
                    amounts.push(beneficiaries[idx].amount);
                    proofs.push(
                        tree.getProof(leaves[idx]).map(p => "0x" + p.data.toString("hex"))
                    );
                    phoneNumbers.push(ethers.keccak256(ethers.toUtf8Bytes(`+22177000${String(idx).padStart(4, "0")}`)));
                }

                await floodPrediction.connect(operator).processBatchPayment(
                    batchEventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)
                );
                totalPaid += 50;
            }

            expect(totalPaid).to.equal(200);
            const stats = await floodPrediction.getSystemStats();
            expect(stats[1]).to.be.gte(200);
        });
    });

    // =====================================================================
    //   A8-14 fix: the full run this file was named after but never did.
    //
    //   Every trigger here used to be created with beneficiaryCount = 50, so an
    //   event completed after a single batch. The 1000 existed only as a Merkle
    //   tree, and the most it ever paid was 200 across four regions. That left the
    //   multi-batch accumulation path untested at every scale in this family: no
    //   test anywhere drove triggerPaidCount from 0 to beneficiaryCount across
    //   twenty batches, watched the trigger flip to PAID, or checked that the
    //   leftover committed budget is released when it does (the A31 path).
    // =====================================================================
    describe(`Batch Payment — ${TOTAL_BENEFICIARIES} Beneficiaries in ${TOTAL_BENEFICIARIES / BATCH_SIZE} Batches of ${BATCH_SIZE}`, function () {
        let eventId;

        beforeEach(async function () {
            this.timeout(60000);
            await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, AMOUNT * TOTAL_BENEFICIARIES, TOTAL_BENEFICIARIES
            );
            const ids = await floodPrediction.getTriggerIds();
            eventId = ids[ids.length - 1];
            await floodPrediction.connect(operator).validateTrigger(eventId);
        });

        function batchArgs(batch) {
            const hashes = [], amounts = [], proofs = [], phoneNumbers = [];
            for (let i = 0; i < BATCH_SIZE; i++) {
                const idx = batch * BATCH_SIZE + i;
                hashes.push(beneficiaries[idx].hash);
                amounts.push(beneficiaries[idx].amount);
                proofs.push(tree.getProof(leaves[idx]).map(p => "0x" + p.data.toString("hex")));
                phoneNumbers.push(ethers.keccak256(ethers.toUtf8Bytes(`+22177${String(idx).padStart(7, "0")}`)));
            }
            return [eventId, hashes, amounts, proofs, phoneNumbers, hashes.map(() => 0)];
        }

        it(`should process all ${TOTAL_BENEFICIARIES} beneficiaries in ${TOTAL_BENEFICIARIES / BATCH_SIZE} sequential batches`, async function () {
            this.timeout(180000);
            const totalBatches = TOTAL_BENEFICIARIES / BATCH_SIZE;

            for (let batch = 0; batch < totalBatches; batch++) {
                await floodPrediction.connect(operator).processBatchPayment(...batchArgs(batch));
                // The count must advance by exactly one batch each time.
                expect(await floodPrediction.triggerPaidCount(eventId))
                    .to.equal(BigInt((batch + 1) * BATCH_SIZE));
            }

            const sampleIndices = [0, 49, 50, 500, 950, 999];
            for (const idx of sampleIndices) {
                expect(await floodPrediction.isBeneficiaryPaid(eventId, beneficiaries[idx].hash)).to.be.true;
            }
            expect(await floodPrediction.triggerPaidCount(eventId)).to.equal(BigInt(TOTAL_BENEFICIARIES));
        });

        it("should mark the trigger PAID once the last batch completes", async function () {
            this.timeout(180000);
            const totalBatches = TOTAL_BENEFICIARIES / BATCH_SIZE;

            for (let batch = 0; batch < totalBatches - 1; batch++) {
                await floodPrediction.connect(operator).processBatchPayment(...batchArgs(batch));
            }
            // 950 of 1000 paid: still VALIDATED, not PAID.
            expect((await floodPrediction.getFloodTrigger(eventId)).status).to.equal(3);

            await floodPrediction.connect(operator).processBatchPayment(...batchArgs(totalBatches - 1));
            expect((await floodPrediction.getFloodTrigger(eventId)).status).to.equal(4); // PAID
            expect((await floodPrediction.getFloodTrigger(eventId)).paidAt).to.be.greaterThan(0n);
        });

        it("should release the committed budget when the event completes", async function () {
            this.timeout(180000);
            const declared = BigInt(AMOUNT * TOTAL_BENEFICIARIES);
            expect(await floodPrediction.committedBudget("SN-TH")).to.equal(declared);

            for (let batch = 0; batch < TOTAL_BENEFICIARIES / BATCH_SIZE; batch++) {
                await floodPrediction.connect(operator).processBatchPayment(...batchArgs(batch));
            }

            // Spend matches the declaration exactly, so nothing is left reserved.
            expect(await floodPrediction.triggerSpentAmount(eventId)).to.equal(declared);
            expect(await floodPrediction.committedBudget("SN-TH")).to.equal(0n);
        });

        it(`should create one Mobile Money order per beneficiary across all batches`, async function () {
            this.timeout(180000);
            for (let batch = 0; batch < TOTAL_BENEFICIARIES / BATCH_SIZE; batch++) {
                await floodPrediction.connect(operator).processBatchPayment(...batchArgs(batch));
            }
            // No dispatch silently lost: the payment rail holds exactly as many orders
            // as the ledger holds payments (A8-01).
            expect(await mobileMoney.totalPaymentsInitiated()).to.equal(BigInt(TOTAL_BENEFICIARIES));
            expect(await mobileMoney.getPendingPaymentCount()).to.equal(BigInt(TOTAL_BENEFICIARIES));
        });

        it(`should measure gas usage per batch across all ${TOTAL_BENEFICIARIES / BATCH_SIZE} batches`, async function () {
            this.timeout(180000);
            const gasUsages = [];
            const totalBatches = TOTAL_BENEFICIARIES / BATCH_SIZE;

            for (let batch = 0; batch < totalBatches; batch++) {
                const tx = await floodPrediction.connect(operator).processBatchPayment(...batchArgs(batch));
                gasUsages.push((await tx.wait()).gasUsed);
            }

            const total = gasUsages.reduce((a, b) => a + b, 0n);
            const max = gasUsages.reduce((a, b) => (b > a ? b : a), 0n);
            const min = gasUsages.reduce((a, b) => (b < a ? b : a), gasUsages[0]);
            const blockGasLimit = 30_000_000n;

            console.log(`\n    📊 Gas Analysis — ${TOTAL_BENEFICIARIES} Beneficiaries (${totalBatches} batches of ${BATCH_SIZE}):`);
            console.log(`       Average gas/batch:   ${(total / BigInt(totalBatches)).toLocaleString()}`);
            console.log(`       Min gas/batch:       ${min.toLocaleString()}`);
            console.log(`       Max gas/batch:       ${max.toLocaleString()}`);
            console.log(`       Total gas:           ${total.toLocaleString()}`);
            console.log(`       Avg gas/beneficiary: ${(total / BigInt(TOTAL_BENEFICIARIES)).toLocaleString()}`);
            console.log(`       Peak block usage:    ${(max * 100n / blockGasLimit)}% of a 30M Polygon block`);
            console.log(`       Coût @ 50 gwei:      ${Number(total) * 50e-9} POL\n`);

            // ARCH-04: a batch must fit in a real Polygon block, not the doubled ceiling
            // the test environment used to assume.
            expect(max).to.be.lessThan(blockGasLimit);
        });
    });

    describe("Duplicate Payment Prevention at Scale", function () {
        let eventId;

        beforeEach(async function () {
            const tx = await floodPrediction.connect(operator).createFloodTrigger(
                "SN-TH", 85, merkleRoot, 50000, 2
            );
            await tx.wait();
            eventId = (await floodPrediction.getTriggerIds())[0];
            await floodPrediction.connect(operator).validateTrigger(eventId);
        });

        it("should prevent re-processing the same beneficiary", async function () {
            const hash = beneficiaries[0].hash;
            const amount = beneficiaries[0].amount;
            const proof = tree.getProof(leaves[0]).map(p => "0x" + p.data.toString("hex"));

            await floodPrediction.connect(operator).processBatchPayment(
                eventId, [hash], [amount], [proof], [ethers.keccak256(ethers.toUtf8Bytes("+221770000001"))], [0]
            );
            expect(await floodPrediction.isBeneficiaryPaid(eventId, hash)).to.be.true;

            await expect(
                floodPrediction.connect(operator).processBatchPayment(
                    eventId, [hash], [amount], [proof], [ethers.keccak256(ethers.toUtf8Bytes("+221770000001"))], [0]
                )
            ).to.be.revertedWithCustomError(floodPrediction, "BeneficiaryAlreadyPaid");
        });
    });
});
