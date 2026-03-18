import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';

import selfsigned from 'selfsigned';

export interface LocalFixtureServer {
  origin: string;
  close(): Promise<void>;
}

export async function startFixtureServer(
  options: { secure?: boolean } = {},
): Promise<LocalFixtureServer> {
  const sockets = new Set<NodeJS.Timeout>();
  const listener = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');

    if (requestUrl.pathname === '/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
      });
      response.write('retry: 1000\n');
      response.write('data: ready\n\n');
      const interval = setInterval(() => {
        response.write('data: ping\n\n');
      }, 250);
      sockets.add(interval);

      request.on('close', () => {
        clearInterval(interval);
        sockets.delete(interval);
      });

      return;
    }

    const html =
      requestUrl.pathname === '/page2'
        ? renderPage2Html()
        : renderFixtureHtml();

    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(html);
  };

  const server = options.secure
    ? https.createServer(await createCertificate(), listener)
    : http.createServer(listener);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('テストサーバの起動に失敗しました。');
  }

  return {
    origin: `${options.secure ? 'https' : 'http'}://localhost:${address.port}`,
    async close() {
      for (const interval of sockets) {
        clearInterval(interval);
      }

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

async function createCertificate(): Promise<{ key: string; cert: string }> {
  const { private: key, cert } = await selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    {
      algorithm: 'sha256',
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: '::1' },
          ],
        },
      ],
    },
  );

  return { key, cert };
}

interface FixturePageConfig {
  title: string;
  bgGradient: string;
  sections: Array<{ tag: 'h1' | 'h2'; text: string }>;
  extraCss?: string;
  extraBody?: string;
}

function renderPage2Html(): string {
  return renderFixturePage({
    title: 'Rollberry Fixture Page 2',
    bgGradient: '#e8f4ef 0%, #d1e8db 50%, #f7efe1 100%',
    sections: [
      { tag: 'h1', text: 'Page 2 Hero' },
      { tag: 'h2', text: 'Page 2 Section 1' },
      { tag: 'h2', text: 'Page 2 Section 2' },
    ],
  });
}

function renderFixtureHtml(): string {
  return renderFixturePage({
    title: 'Rollberry Fixture',
    bgGradient: '#f7efe1 0%, #f3d8b6 50%, #e8f4ef 100%',
    sections: [
      { tag: 'h1', text: 'Fixture Hero' },
      { tag: 'h2', text: 'Section 1' },
      { tag: 'h2', text: 'Section 2' },
      { tag: 'h2', text: 'Section 3' },
    ],
    extraCss: `
      #cookie-banner {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 10;
        padding: 14px 18px;
        border-radius: 999px;
        background: rgba(28, 29, 31, 0.92);
        color: #fff;
        animation: pulse 0.8s infinite alternate;
      }

      @keyframes pulse {
        from { transform: translateY(0); }
        to { transform: translateY(-6px); }
      }`,
    extraBody: `    <div id="cookie-banner">Cookie Banner</div>
    <script>
      const stream = new EventSource('/events');
      stream.onmessage = () => {};

      let extraAppended = false;
      const appendExtraPanel = () => {
        if (extraAppended || window.scrollY < 600) return;
        extraAppended = true;
        const section = document.createElement('section');
        section.className = 'panel';
        section.id = 'lazy-loaded';
        section.innerHTML = '<h2>Lazy Loaded</h2>';
        document.body.appendChild(section);
      };

      window.addEventListener('scroll', appendExtraPanel, { passive: true });
    </script>`,
  });
}

function renderFixturePage(config: FixturePageConfig): string {
  const sections = config.sections
    .map(
      (s) =>
        `    <section class="panel"><${s.tag}>${s.text}</${s.tag}></section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${config.title}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      }

      body {
        margin: 0;
        background: linear-gradient(180deg, ${config.bgGradient});
        color: #1c1d1f;
      }

      .panel {
        min-height: 720px;
        display: grid;
        place-items: center;
        border-bottom: 1px solid rgba(0, 0, 0, 0.08);
      }

      .panel h1,
      .panel h2 {
        margin: 0;
        font-size: clamp(3rem, 8vw, 5rem);
        letter-spacing: -0.06em;
      }${config.extraCss ?? ''}
    </style>
  </head>
  <body>
${config.extraBody ? `${config.extraBody}\n` : ''}${sections}
  </body>
</html>`;
}
