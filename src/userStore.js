const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_FILE = path.resolve(__dirname, '..', 'users.json');

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    const salt = crypto.randomBytes(16).toString('hex');
    const adminUser = {
      username: 'admin',
      password_hash: hashPassword('admin', salt),
      salt,
      role: 'admin',
      allowed_profiles: ['*']
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify([adminUser], null, 2), 'utf-8');
    return [adminUser];
  }
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}

function findUser(username) {
  const users = loadUsers();
  return users.find((u) => u.username === username);
}

function verifyPassword(username, password) {
  const user = findUser(username);
  if (!user) return false;
  const hash = hashPassword(password, user.salt);
  return hash === user.password_hash;
}

function createUser({ username, password, role, allowed_profiles }) {
  const users = loadUsers();
  if (users.find((u) => u.username === username)) {
    throw new Error('Username already exists.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  users.push({
    username,
    password_hash: hashPassword(password, salt),
    salt,
    role: role || 'client',
    allowed_profiles: Array.isArray(allowed_profiles) ? allowed_profiles : ['*']
  });
  saveUsers(users);
  return { username, role, allowed_profiles };
}

function updateUser(username, updates) {
  const users = loadUsers();
  const index = users.findIndex((u) => u.username === username);
  if (index === -1) throw new Error('User not found.');

  if (updates.password) {
    users[index].salt = crypto.randomBytes(16).toString('hex');
    users[index].password_hash = hashPassword(updates.password, users[index].salt);
  }
  if (updates.role !== undefined) users[index].role = updates.role;
  if (updates.allowed_profiles !== undefined) {
    users[index].allowed_profiles = Array.isArray(updates.allowed_profiles)
      ? updates.allowed_profiles
      : ['*'];
  }

  saveUsers(users);
  return {
    username: users[index].username,
    role: users[index].role,
    allowed_profiles: users[index].allowed_profiles
  };
}

function deleteUser(username) {
  const users = loadUsers();
  if (username === 'admin') throw new Error('Cannot delete the default admin account.');
  const filtered = users.filter((u) => u.username !== username);
  if (filtered.length === users.length) throw new Error('User not found.');
  saveUsers(filtered);
}

function listUsers() {
  return loadUsers().map((u) => ({
    username: u.username,
    role: u.role,
    allowed_profiles: u.allowed_profiles
  }));
}

module.exports = {
  findUser,
  verifyPassword,
  createUser,
  updateUser,
  deleteUser,
  listUsers
};
