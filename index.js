import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter';

if (cluster.isPrimary) {
  const numCPUs = 3;
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({ PORT: 3000 + i });
  }
  setupPrimary();
} else {
  const db = await open({
    filename: 'chat.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT,
      username TEXT,
      room TEXT
    );
  `);

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
    adapter: createAdapter()
  });

  const __dirname = dirname(fileURLToPath(import.meta.url));
  app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
  });

  let activeRooms = new Set();
  const activeUsernames = new Set();

  io.on('connection', async (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('join room', async (username, room) => {
      if (!username) return;
      if (!room) room = "default";

      const oldRoom = Array.from(socket.rooms)[1];
      if (oldRoom) {
        socket.leave(oldRoom);
        io.to(oldRoom).emit('leave room', username, oldRoom);
      }

      socket.username = username;
      socket.room = room;
      socket.join(room);
      activeRooms.add(room);
      io.to(room).emit('join room', username, room);
      console.log(`${username} joined room: ${room}`);

      try {
        const messages = await db.all('SELECT id, username, content FROM messages WHERE room = ? ORDER BY id ASC', [room]);
        messages.forEach(({ id, username, content }) => {
          socket.emit('chat message', { user: username, text: content, room }, id);
        });
      } catch (e) {
        console.error("Error fetching messages:", e);
      }
    });

    socket.on('chat message', async (data, clientOffset, callback) => {
      const { user, room, text } = data;
      if (!user || !room || !text) return;

      let result;
      try {
        result = await db.run('INSERT INTO messages (username, content, client_offset, room) VALUES (?, ?, ?, ?)',
          user, text, clientOffset, room);
      } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
          callback && callback();
        }
        return;
      }

      io.to(room).emit('chat message', { user, text, room }, result.lastID);
      callback && callback();
    });

    socket.on('disconnect', () => {
      console.log(`${socket.username || 'Unknown user'} disconnected`);
      if (socket.username && socket.room) {
        io.to(socket.room).emit('leave room', socket.username, socket.room);
      }
    });
  });

  const port = process.env.PORT;
  server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}
