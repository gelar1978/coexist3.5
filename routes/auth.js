const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { pool } = require('../db/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ==================== REGISTRASI ====================
router.post('/register', async (req, res) => {
    try {
        const { username, email, password, confirmPassword } = req.body;

        // Validasi input
        if (!username || !email || !password || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Semua field harus diisi'
            });
        }

        if (password !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Password dan konfirmasi password tidak cocok'
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password minimal 6 karakter'
            });
        }

        // Validasi email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'Format email tidak valid'
            });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Insert ke database
        const [result] = await pool.query(
            'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
            [username, email, passwordHash]
        );

        // Log aktivitas (opsional)
        try {
            await pool.query(
                'INSERT INTO user_logs (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                [result.insertId, 'register', req.ip || req.connection.remoteAddress, req.headers['user-agent']]
            );
        } catch (logError) {
            console.log('Log error (non-critical):', logError.message);
        }

        res.status(201).json({
            success: true,
            message: 'Registrasi berhasil! Silakan login.'
        });

    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({
                success: false,
                message: 'Username atau email sudah terdaftar'
            });
        }
        console.error('Register error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server saat registrasi'
        });
    }
});

// ==================== LOGIN ====================
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username dan password wajib diisi'
            });
        }

        // Cari user (bisa login dengan username atau email)
        const [rows] = await pool.query(
            'SELECT id, username, email, password_hash FROM users WHERE (username = ? OR email = ?) AND is_active = 1',
            [username, username]
        );

        if (rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Username/email atau password salah'
            });
        }

        const user = rows[0];

        // Verifikasi password
        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({
                success: false,
                message: 'Username/email atau password salah'
            });
        }

        // Update last_login
        await pool.query(
            'UPDATE users SET last_login = NOW() WHERE id = ?',
            [user.id]
        );

        // Log aktivitas
        try {
            await pool.query(
                'INSERT INTO user_logs (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                [user.id, 'login', req.ip || req.connection.remoteAddress, req.headers['user-agent']]
            );
        } catch (logError) {
            console.log('Log error (non-critical):', logError.message);
        }

        // Buat session
        req.session.userId = user.id;
        req.session.username = user.username;

        // Buat JWT token
        const token = jwt.sign(
            { userId: user.id, username: user.username, email: user.email },
            process.env.JWT_SECRET || 'default_secret_key',
            { expiresIn: '7d' }
        );

        // Set cookie
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 hari
        });

        res.json({
            success: true,
            message: 'Login berhasil',
            user: {
                id: user.id,
                username: user.username,
                email: user.email
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server saat login'
        });
    }
});

// ==================== LOGOUT ====================
router.post('/logout', (req, res) => {
    try {
        // Log aktivitas
        if (req.session && req.session.userId) {
            try {
                pool.query(
                    'INSERT INTO user_logs (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                    [req.session.userId, 'logout', req.ip || req.connection.remoteAddress, req.headers['user-agent']]
                );
            } catch (logError) {
                console.log('Log error (non-critical):', logError.message);
            }
        }

        // Destroy session
        req.session.destroy((err) => {
            if (err) {
                console.error('Session destroy error:', err);
                return res.status(500).json({
                    success: false,
                    message: 'Gagal logout'
                });
            }
            res.clearCookie('token');
            res.json({
                success: true,
                message: 'Logout berhasil'
            });
        });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server saat logout'
        });
    }
});

// ==================== CEK STATUS LOGIN ====================
router.get('/me', authenticate, async (req, res) => {
    try {
        res.json({
            success: true,
            user: req.user
        });
    } catch (error) {
        console.error('Check user error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server'
        });
    }
});

// ==================== LUPA PASSWORD (Request Reset) ====================
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email wajib diisi'
            });
        }

        // Cek user
        const [rows] = await pool.query(
            'SELECT id, username FROM users WHERE email = ? AND is_active = 1',
            [email]
        );

        if (rows.length === 0) {
            // Jangan kasih tahu email tidak terdaftar (security)
            return res.json({
                success: true,
                message: 'Jika email terdaftar, instruksi reset akan dikirim'
            });
        }

        const user = rows[0];

        // Generate reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const tokenExpiry = new Date();
        tokenExpiry.setHours(tokenExpiry.getHours() + 1); // 1 jam

        // Simpan token ke database
        await pool.query(
            'UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?',
            [resetToken, tokenExpiry, user.id]
        );

        // Buat reset link
        const resetLink = process.env.NODE_ENV === 'production' 
            ? `https://coexist35.harukaindonesia.id/reset-password.html?token=${resetToken}` 
            : `http://localhost:${process.env.PORT || 3000}/reset-password.html?token=${resetToken}`;

        // Log untuk debugging
        console.log(`🔗 Link Reset Password untuk ${user.username}: ${resetLink}`);
        console.log(`📧 Email: ${email}`);
        console.log(`🔑 Token: ${resetToken}`);

        // Konfigurasi transporter nodemailer
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: process.env.SMTP_PORT == 465, // true untuk port 465, false untuk port lain
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        const mailOptions = {
            from: `"Coexist 3.5" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
            to: email,
            subject: 'Reset Password Coexist 3.5',
            text: `Halo ${user.username},\n\nAnda meminta untuk mereset password Anda.\n\nBerikut adalah token reset password Anda:\n${resetToken}\n\nMasukkan token tersebut pada halaman reset password untuk membuat password baru.\n\nAtau Anda bisa klik link berikut:\n${resetLink}\n\nJika Anda tidak meminta reset password, abaikan email ini.`,
            html: `<p>Halo <strong>${user.username}</strong>,</p>
                   <p>Anda meminta untuk mereset password Anda.</p>
                   <p>Berikut adalah token reset password Anda:</p>
                   <h3 style="background: #f4f4f4; padding: 10px; display: inline-block;">${resetToken}</h3>
                   <p>Masukkan token tersebut pada halaman reset password untuk membuat password baru.</p>
                   <p>Atau Anda bisa klik link berikut: <br> <a href="${resetLink}">${resetLink}</a></p>
                   <p><small>Jika Anda tidak meminta reset password, abaikan email ini.</small></p>`
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (mailErr) {
            console.error('Gagal mengirim email:', mailErr);
            return res.status(500).json({
                success: false,
                message: 'Gagal mengirim email reset password. Pastikan konfigurasi SMTP di .env benar.'
            });
        }

        // Simpan log permintaan reset
        try {
            await pool.query(
                'INSERT INTO user_logs (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                [user.id, 'forgot_password', req.ip || req.connection.remoteAddress, req.headers['user-agent']]
            );
        } catch (logError) {
            console.log('Log error (non-critical):', logError.message);
        }

        res.json({
            success: true,
            message: 'Instruksi reset password dan token telah dikirim ke email Anda'
        });

    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server saat memproses reset password'
        });
    }
});

// ==================== RESET PASSWORD (dengan token) ====================
router.post('/reset-password', async (req, res) => {
    try {
        const { token, newPassword, confirmPassword } = req.body;

        if (!token || !newPassword || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Semua field wajib diisi'
            });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Password tidak cocok'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password minimal 6 karakter'
            });
        }

        // Cek token
        const [rows] = await pool.query(
            'SELECT id, username FROM users WHERE reset_token = ? AND reset_token_expiry > NOW() AND is_active = 1',
            [token]
        );

        if (rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Token tidak valid atau telah kadaluarsa'
            });
        }

        const user = rows[0];

        // Hash password baru
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(newPassword, salt);

        // Update password dan hapus token
        await pool.query(
            'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
            [passwordHash, user.id]
        );

        // Log aktivitas
        try {
            await pool.query(
                'INSERT INTO user_logs (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                [user.id, 'reset_password', req.ip || req.connection.remoteAddress, req.headers['user-agent']]
            );
        } catch (logError) {
            console.log('Log error (non-critical):', logError.message);
        }

        res.json({
            success: true,
            message: 'Password berhasil direset! Silakan login.'
        });

    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server saat reset password'
        });
    }
});

// ==================== UBAH PASSWORD (User sudah login) ====================
router.post('/change-password', authenticate, async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;
        const userId = req.user.id;

        if (!currentPassword || !newPassword || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Semua field wajib diisi'
            });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: 'Password baru tidak cocok'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password minimal 6 karakter'
            });
        }

        // Ambil password saat ini
        const [rows] = await pool.query(
            'SELECT password_hash FROM users WHERE id = ?',
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User tidak ditemukan'
            });
        }

        // Verifikasi password saat ini
        const isValid = await bcrypt.compare(currentPassword, rows[0].password_hash);
        if (!isValid) {
            return res.status(401).json({
                success: false,
                message: 'Password saat ini salah'
            });
        }

        // Hash password baru
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(newPassword, salt);

        // Update password
        await pool.query(
            'UPDATE users SET password_hash = ? WHERE id = ?',
            [passwordHash, userId]
        );

        // Log aktivitas
        try {
            await pool.query(
                'INSERT INTO user_logs (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                [userId, 'change_password', req.ip || req.connection.remoteAddress, req.headers['user-agent']]
            );
        } catch (logError) {
            console.log('Log error (non-critical):', logError.message);
        }

        res.json({
            success: true,
            message: 'Password berhasil diubah!'
        });

    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server saat mengubah password'
        });
    }
});

// ==================== GET ALL USERS (Admin only - contoh) ====================
router.get('/users', authenticate, async (req, res) => {
    try {
        // Cek apakah user adalah admin (contoh sederhana)
        // Untuk demo, kita tampilkan semua user
        const [rows] = await pool.query(
            'SELECT id, username, email, created_at, last_login, is_active FROM users ORDER BY id DESC LIMIT 50'
        );

        res.json({
            success: true,
            users: rows
        });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server'
        });
    }
});

module.exports = router;
