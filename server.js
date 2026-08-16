const express = require('express');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');

// Import database dan routes
const { testConnection } = require('./db/database');
const authRoutes = require('./routes/auth');
const calculatorRoutes = require('./routes/calculator');
const stationsRoutes = require('./routes/stations');

// Load environment variables
dotenv.config();

const app = express();
app.set('trust proxy', 1); // Tambahkan ini agar rate-limit bekerja di balik reverse proxy
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"], // Tambahkan ini
            imgSrc: ["'self'", "data:"],
        },
    },
}));

// CORS
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? ['https://coexist35.harukaindonesia.id', 'https://harukaindonesia.id', 'https://www.harukaindonesia.id']
        : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting (mencegah brute force)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 10000, // dinaikkan dari 100 menjadi 10000 request per IP untuk mendukung chunking upload Excel
    message: {
        success: false,
        message: 'Terlalu banyak permintaan, coba lagi nanti'
    },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', limiter);

// Rate limiting lebih ketat untuk login/register
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20, // 20 request per 15 menit untuk auth
    message: {
        success: false,
        message: 'Terlalu banyak percobaan login, coba lagi nanti'
    },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Parser
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// Session
app.use(session({
    secret: process.env.SESSION_SECRET || 'default_session_secret_key_12345',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 hari
    },
    name: 'session_id'
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Logging middleware (untuk debugging)
app.use((req, res, next) => {
    console.log(`📝 ${req.method} ${req.url} - ${req.ip}`);
    next();
});

// ==================== ROUTES ====================

// Health check
app.get('/health', (req, res) => {
    res.json({
        success: true,
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Auth routes
app.use('/api/auth', authRoutes);

// Calculator routes
app.use('/api/calculator', calculatorRoutes);

// Stations routes
app.use('/api/stations', stationsRoutes);

// ==================== PAGE ROUTES ====================

// Halaman utama - redirect ke login
app.get('/', (req, res) => {
    if (req.session && req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.redirect('/login.html');
});

// Dashboard (kalkulator) - harus login
app.get('/dashboard', (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.redirect('/login.html');
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Halaman login
app.get('/login', (req, res) => {
    if (req.session && req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Halaman register
app.get('/register', (req, res) => {
    if (req.session && req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Halaman reset password
app.get('/reset-password', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

// Halaman change password (harus login)
app.get('/change-password', (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.redirect('/login.html');
    }
    res.sendFile(path.join(__dirname, 'public', 'change-password.html'));
});

// ==================== ERROR HANDLING ====================

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint tidak ditemukan'
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('❌ Global error:', err);
    res.status(500).json({
        success: false,
        message: 'Terjadi kesalahan server internal',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ==================== START SERVER ====================

async function startServer() {
    console.log('🚀 Starting server...');

    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
        console.error('❌ Server tidak bisa berjalan tanpa database');
        console.error('📌 Pastikan:');
        console.error('   1. Database MariaDB/MySQL sudah berjalan');
        console.error('   2. Kredensial di .env benar');
        console.error('   3. Database "' + process.env.DB_NAME + '" sudah dibuat');
        process.exit(1);
    }

    // Start server with port fallback handling
    const listen = (portToTry) => {
        const server = app.listen(portToTry, () => {
            console.log(`\n✅ Server berhasil dijalankan!`);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`🌐 URL        : http://localhost:${portToTry}`);
            console.log(`📊 Database   : ${process.env.DB_NAME}`);
            console.log(`🔐 Mode       : ${process.env.NODE_ENV || 'development'}`);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`📌 Halaman yang tersedia:`);
            console.log(`   - Login         : http://localhost:${portToTry}/login`);
            console.log(`   - Register      : http://localhost:${portToTry}/register`);
            console.log(`   - Reset Password: http://localhost:${portToTry}/reset-password`);
            console.log(`   - Dashboard     : http://localhost:${portToTry}/dashboard`);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        });

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.warn(`⚠️ Port ${portToTry} sedang digunakan oleh proses lain.`);
                const nextPort = Number(portToTry) + 1;
                console.log(`🔄 Mencoba menjalankan server di port alternatif: ${nextPort}...`);
                listen(nextPort);
            } else {
                console.error('❌ Server error:', err);
            }
        });
    };

    listen(PORT);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n⏹️ Server dihentikan...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n⏹️ Server dihentikan...');
    process.exit(0);
});

// Start server
startServer();
