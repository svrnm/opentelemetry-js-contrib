/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/tracing';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { NodeTracerProvider } from '@opentelemetry/node';
import * as net from 'net';
import * as assert from 'assert';
import * as tls from 'tls';
import { NetInstrumentation } from '../src/net';
import { SocketEvent } from '../src/types';
import {
  assertIpcSpan,
  assertTcpSpan,
  assertTLSSpan,
  IPC_PATH,
  HOST,
  PORT,
  TLS_SERVER_CERT,
  TLS_SERVER_KEY,
  TLS_PORT,
} from './utils';

const memoryExporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));

function getSpan() {
  const spans = memoryExporter.getFinishedSpans();
  assert.strictEqual(spans.length, 1);
  const [span] = spans;
  return span;
}

function getTLSSpans() {
  const spans = memoryExporter.getFinishedSpans();
  assert.strictEqual(spans.length, 2);
  const [netSpan, tlsSpan] = spans;
  return {
    netSpan,
    tlsSpan,
  };
}

describe('NetInstrumentation', () => {
  let instrumentation: NetInstrumentation;
  let socket: net.Socket;
  let tcpServer: net.Server;
  let ipcServer: net.Server;
  let tlsServer: tls.Server;

  before(() => {
    instrumentation = new NetInstrumentation();
    instrumentation.setTracerProvider(provider);
    require('net');
  });

  before(done => {
    tcpServer = net.createServer();
    tcpServer.listen(PORT, done);
  });

  before(done => {
    ipcServer = net.createServer();
    ipcServer.listen(IPC_PATH, done);
  });

  before(done => {
    tlsServer = tls.createServer({
      cert: TLS_SERVER_CERT,
      key: TLS_SERVER_KEY,
    });

    tlsServer.listen(TLS_PORT, done);
  });

  beforeEach(() => {
    socket = new net.Socket();
  });

  afterEach(() => {
    socket.destroy();
    memoryExporter.reset();
  });

  after(() => {
    instrumentation.disable();
    tcpServer.close();
    ipcServer.close();
    tlsServer.close();
  });

  describe('successful net.connect produces a span', () => {
    it('should produce a span given port and host', done => {
      socket = net.connect(PORT, HOST, () => {
        assertTcpSpan(getSpan(), socket);
        done();
      });
    });

    it('should produce a span for IPC', done => {
      socket = net.connect(IPC_PATH, () => {
        assertIpcSpan(getSpan());
        done();
      });
    });

    it('should produce a span given options', done => {
      socket = net.connect(
        {
          port: PORT,
          host: HOST,
        },
        () => {
          assertTcpSpan(getSpan(), socket);
          done();
        }
      );
    });
  });

  describe('successful net.createConnection produces a span', () => {
    it('should produce a span given port and host', done => {
      socket = net.createConnection(PORT, HOST, () => {
        assertTcpSpan(getSpan(), socket);
        done();
      });
    });

    it('should produce a span for IPC', done => {
      socket = net.createConnection(IPC_PATH, () => {
        assertIpcSpan(getSpan());
        done();
      });
    });

    it('should produce a span given options', done => {
      socket = net.createConnection(
        {
          port: PORT,
          host: HOST,
        },
        () => {
          assertTcpSpan(getSpan(), socket);
          done();
        }
      );
    });
  });

  describe('successful Socket.connect produces a span', () => {
    it('should produce a span given port and host', done => {
      socket.connect(PORT, HOST, () => {
        assertTcpSpan(getSpan(), socket);
        done();
      });
    });

    it('should produce a span for IPC', done => {
      socket.connect(IPC_PATH, () => {
        assertIpcSpan(getSpan());
        done();
      });
    });

    it('should produce a span given options', done => {
      socket.connect(
        {
          port: PORT,
          host: HOST,
        },
        () => {
          assertTcpSpan(getSpan(), socket);
          done();
        }
      );
    });
  });

  describe('successful tls.connect produces a span', () => {
    it('should produce a span with "onSecure" callback', done => {
      const tlsSocket = tls.connect(
        TLS_PORT,
        HOST,
        {
          ca: [TLS_SERVER_CERT],
          checkServerIdentity: () => {
            return undefined;
          },
        },
        () => {
          assertTLSSpan(getTLSSpans(), tlsSocket);
          done();
          // This needs to be here to make sure that mocha can close cleanly.
          tlsSocket.destroy();
        }
      );
    });

    it('should produce a span without "onSecure" callback', done => {
      socket = tls.connect(TLS_PORT, HOST, {
        ca: [TLS_SERVER_CERT],
        checkServerIdentity: () => {
          return undefined;
        },
      });
      tlsServer.on('connection', c => {
        c.end();
      });
      socket.on('end', () => {
        assertTLSSpan(getTLSSpans(), socket);
        done();
      });
    });

    it('should produce an error span when certificate is not trusted', done => {
      socket = tls.connect(
        TLS_PORT,
        HOST,
        {
          ca: [],
          checkServerIdentity: () => {
            return undefined;
          },
        },
        () => {
          assertTLSSpan(getTLSSpans(), socket);
          done();
        }
      );
      socket.on('error', error => {
        const { tlsSpan } = getTLSSpans();
        // assertTcpSpan(netSpan, tlsSocket, TLS_PORT)
        assert.strictEqual(tlsSpan.status.message, 'self signed certificate');
        assert.strictEqual(tlsSpan.status.code, SpanStatusCode.ERROR);
        done();
      });
    });
  });

  describe('invalid input', () => {
    it('should produce an error span when connect throws', done => {
      assert.throws(() => {
        // Invalid cast on purpose to avoid compiler errors.
        socket.connect({ port: {} } as { port: number });
      });

      assert.strictEqual(getSpan().status.code, SpanStatusCode.ERROR);

      done();
    });

    it('should produce a generic span in case transport type can not be determined', done => {
      socket.once(SocketEvent.CLOSE, () => {
        const span = getSpan();
        assert.strictEqual(
          span.attributes[SemanticAttributes.NET_TRANSPORT],
          undefined
        );
        assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
        done();
      });
      socket.connect((undefined as unknown) as string);
    });
  });

  describe('cleanup', () => {
    function assertNoDanglingListeners() {
      const events = new Set(socket.eventNames());
      for (const event of [
        SocketEvent.CLOSE,
        SocketEvent.CONNECT,
        SocketEvent.ERROR,
        SocketEvent.SECURE_CONNECT,
      ]) {
        assert.equal(events.has(event), false);
      }
    }

    it('should clean up listeners when destroying the socket', done => {
      socket.connect(PORT);
      socket.destroy();
      socket.once(SocketEvent.CLOSE, () => {
        assertNoDanglingListeners();
        done();
      });
    });

    it('should clean up listeners when successfully connecting', done => {
      socket.connect(PORT, () => {
        assertNoDanglingListeners();
        done();
      });
    });

    it('should finish previous span when connecting twice', done => {
      socket.connect(PORT, () => {
        socket.destroy();
        socket.connect(PORT, () => {
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 2);
          done();
        });
      });
    });

    it('should clean up listeners for tls.connect', done => {
      tls.connect(
        TLS_PORT,
        HOST,
        {
          ca: [TLS_SERVER_CERT],
          checkServerIdentity: () => {
            return undefined;
          },
        },
        () => {
          assertNoDanglingListeners();
          done();
        }
      );
    });
  });
});
