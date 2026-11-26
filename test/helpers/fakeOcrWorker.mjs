// Stand-in for src/server/ocr/worker.ts: speaks the same protocol without loading any model.
// The reported provider follows the device option ("cuda" → cuda, otherwise cpu). The "text" of a
// request is its bytes: "crash" ends the process, "fail" answers with an error, "slow …" takes 200 ms.
const options = JSON.parse(process.argv[2]);
const provider = options.device === 'cuda' ? 'cuda' : 'cpu';
process.on('disconnect', () => process.exit(0));

let ready = false;
process.on('message', async (req) => {
  if (!ready) {
    ready = true;
    process.send({ type: 'ready', provider });
  }
  const text = Buffer.from(req.bytes).toString('utf8');
  if (text === 'crash') process.exit(3);
  if (text.startsWith('slow')) await new Promise((resolve) => setTimeout(resolve, 200));
  process.send({ type: 'progress', id: req.id, page: 1, pages: 1 });
  if (text === 'fail') return process.send({ type: 'error', id: req.id, error: 'cannot read this file' });
  const page = { text: `read: ${text} (pid ${process.pid})`, lines: 1, layout: { lines: [], textChars: 0 }, meanScore: 0.9, rotation: 0, width: 1, height: 1, ms: 1 };
  process.send({ type: 'result', id: req.id, pages: [page], totalPages: 1, provider });
});
