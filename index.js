import express from 'express';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {Server} from 'socket.io';

const app = express();
const server = createServer(app);
const io = new Server(server);

const __dirname = dirname(fileURLToPath(import.meta.url));
app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
});

// Store user information
const users = {};
// Store room information
const rooms = {
    'General': {users: []}
};

// Get users in a specific room
const getRoomUsers = (roomName) => Object.entries(users)
    .filter(([_, user]) => user.room === roomName)
    .map(([id, user]) => ({...user, id}));

// Get all rooms and user count in each room
const getRoomList = () => Object.keys(rooms).map(room => ({
    name: room,
    users: getRoomUsers(room).length
}));

// Check if a username is already taken
const isUsernameTaken = (username) => Object.values(users).some(user => user.username === username);

// Format system messages
const formatSystemMessage = (text) => ({type: 'system', text});

// Format chat messages
const formatChatMessage = (room, username, text, isSelf = false) => ({
    type: 'chat',
    text: `${isSelf ? `[${room}] ${username} (you)` : `[${room}] ${username}`}: ${text}`
});

io.on('connection', (socket) => {
    // Generate a default username
    let defaultUsername;
    do {
        defaultUsername = `user${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
    } while (isUsernameTaken(defaultUsername));

    // Default room
    const defaultRoom = 'General';
    users[socket.id] = {username: defaultUsername, room: defaultRoom};

    // Create default room if not exists
    rooms[defaultRoom] ??= {users: []};

    // Join default room
    socket.join(defaultRoom);
    rooms[defaultRoom].users.push(socket.id);

    // Notify user upon joining
    const roomUsers = getRoomUsers(defaultRoom);
    socket.emit('message', formatSystemMessage(`You have joined ${defaultRoom} (${roomUsers.length} users connected)`));
    socket.emit('message', formatSystemMessage(`Your username is ${defaultUsername}`));
    socket.emit('message', formatSystemMessage(`Available chatrooms: ${getRoomList().map(r => `${r.name} (${r.users})`).join('; ')}`));
    socket.to(defaultRoom).emit('message', formatSystemMessage(`${defaultUsername} joined ${defaultRoom}. Users now: ${roomUsers.length}`));

    // Send user info and room updates
    socket.emit('userInfo', {username: defaultUsername, room: defaultRoom});
    io.emit('roomList', getRoomList());
    io.to(defaultRoom).emit('userList', roomUsers.map(user => ({
        username: user.username,
        isSelf: user.username === defaultUsername
    })));

    // Handle room join and username change
    socket.on('joinRoom', ({username: newUsername, room: newRoom}) => {
        const currentUser = users[socket.id];
        const {username: oldUsername, room: oldRoom} = currentUser;

        let updated = false;

        // Handle username change
        if (newUsername && newUsername !== oldUsername && !isUsernameTaken(newUsername)) {
            currentUser.username = newUsername;
            socket.emit('message', formatSystemMessage(`You are now known as ${newUsername}`));
            socket.to(oldRoom).emit('message', formatSystemMessage(`${oldUsername} is now known as ${newUsername}`));
            updated = true;
        } else if (newUsername && isUsernameTaken(newUsername)) {
            socket.emit('message', formatSystemMessage(`Username '${newUsername}' is already in use`));
        }

        // Handle room change
        if (newRoom && newRoom !== oldRoom) {
            rooms[newRoom] ??= {users: []};

            socket.leave(oldRoom);
            rooms[oldRoom].users = rooms[oldRoom].users.filter(id => id !== socket.id);
            socket.to(oldRoom).emit('message', formatSystemMessage(`${currentUser.username} left. Users now: ${rooms[oldRoom].users.length}`));

            if (!rooms[oldRoom].users.length && oldRoom !== 'General') delete rooms[oldRoom];

            socket.join(newRoom);
            rooms[newRoom].users.push(socket.id);
            currentUser.room = newRoom;

            socket.emit('message', formatSystemMessage(`You are now in ${newRoom} (${getRoomUsers(newRoom).length} users connected)`));
            socket.to(newRoom).emit('message', formatSystemMessage(`${currentUser.username} joined. Users now: ${getRoomUsers(newRoom).length}`));
            updated = true;
        }

        if (updated) {
            socket.emit('userInfo', {username: currentUser.username, room: currentUser.room});
            io.emit('roomList', getRoomList());
            io.to(currentUser.room).emit('userList', getRoomUsers(currentUser.room).map(user => ({
                username: user.username,
                isSelf: user.username === currentUser.username
            })));
        }
    });

    // Handle chat messages
    socket.on('chatMessage', (msg) => {
        const user = users[socket.id];
        if (!user || !msg) return;

        io.to(user.room).emit('message', formatChatMessage(user.room, user.username, msg));
    });

    // Handle user disconnect
    socket.on('disconnect', () => {
        const {room, username} = users[socket.id] || {};
        if (!users[socket.id]) return;

        rooms[room].users = rooms[room].users.filter(id => id !== socket.id);
        socket.to(room).emit('message', formatSystemMessage(`${username} disconnected. Users now: ${getRoomUsers(room).length}`));

        if (!rooms[room].users.length && room !== 'General') delete rooms[room];

        io.emit('roomList', getRoomList());
        io.to(room).emit('userList', getRoomUsers(room).map(user => ({username: user.username, isSelf: false})));

        delete users[socket.id];
    });
});

// Start server
const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});