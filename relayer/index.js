import 'dotenv/config';
import fs from 'node:fs/promises';
import { RelayerService } from './service.js';

const service = new RelayerService();

async function printUsage() {
  console.log('Usage: node relayer/index.js <command> [args]');
  console.log('Commands:');
  console.log('  start                              Start event listener');
  console.log('  submit-satellite <file>            Submit satellite data JSON array to WASDI connector');
  console.log('  submit-batch <file>                Submit batch payment request JSON array to MobileMoneyProvider');
  console.log('  confirm-batch <file>               Confirm batch payments from JSON array');
}

async function run() {
  const command = process.argv[2] || 'start';

  if (command === 'start') {
    await service.start();
    return;
  }

  const filePath = process.argv[3];
  if (!filePath) {
    console.error('[relayer] missing file path');
    await printUsage();
    process.exit(1);
  }

  const raw = await fs.readFile(filePath, 'utf8');
  const payload = JSON.parse(raw);

  switch (command) {
    case 'submit-satellite':
      await service._connect();
      await service.submitSatelliteEntries(payload);
      break;
    case 'submit-batch':
      await service._connect();
      await service.submitBatchPayments(payload);
      break;
    case 'confirm-batch':
      await service._connect();
      await service.confirmBatchPayments(payload);
      break;
    default:
      console.error('[relayer] unknown command', command);
      await printUsage();
      process.exit(1);
  }
}

run().catch((error) => {
  console.error('[relayer] fatal error:', error);
  process.exit(1);
});
