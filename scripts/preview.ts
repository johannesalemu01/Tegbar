/** Design preview without Telegram or a bot token: npm run preview → http://localhost:5173/app/?demo=1 */
import { createServer } from 'node:http';
import { createStaticHandler } from '../src/core/http/static.js';

const serve = createStaticHandler();
const port = Number(process.env.PORT ?? 5173);
createServer(async (req, res) => {
  if (!(await serve(req, res))) res.writeHead(302, { location: '/app/?demo=1' }).end();
}).listen(port, '127.0.0.1', () => console.log(`Mini App preview: http://localhost:${port}/app/?demo=1`));
