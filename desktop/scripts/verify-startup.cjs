const ws = new WebSocket(process.argv[2]);
const timeout = setTimeout(() => { console.error('Renderer did not activate camera output'); process.exit(1); }, 10000);
ws.onopen = () => ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{awaitPromise:true,returnByValue:true,
  expression:`new Promise(resolve => { const timer = setInterval(() => {
    if (document.querySelector('#virtualState').dataset.live === 'true') {
      clearInterval(timer);
      resolve(true);
    }
  }, 100); })`}}));
ws.onmessage = ({data}) => {
  if (JSON.parse(data).result?.result?.value !== true) return;
  clearTimeout(timeout);
  ws.close();
};
