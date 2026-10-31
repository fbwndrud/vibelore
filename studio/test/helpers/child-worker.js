import { openStudio } from '../../src/engine/index.js';
const [directory, url, mode] = process.argv.slice(2);
const service = await openStudio({ directory });
const { runWorker } = await import('../../src/engine/worker.js');
const gate = () => new Promise((resolve) => process.once('message', resolve));
const provider = {
  capabilities: () => ({
    kinds: ['image'],
    models: ['fake-v1'],
    inspect: false
  }),
  async generate(request) {
    if (mode === 'before') {
      process.send({ stage: 'before-send' });
      await gate();
    }
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(request)
    });
    const data = await response.json();
    if (mode === 'after-response') {
      process.send({ stage: 'after-response' });
      await gate();
    }
    return {
      ...data,
      outputs: data.outputs.map((o) => ({
        ...o,
        bytes: Uint8Array.from(o.bytes)
      }))
    };
  }
};
await runWorker({ service, providers: { fake: provider }, drain: true });
process.send({ stage: 'done' });
await service.close();
process.disconnect();
