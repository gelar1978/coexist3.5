const jwt = require('jsonwebtoken');
const { pool } = require('../db/database');

const authenticate = async (req, res, next) => {
    try {
        if (req.session && req.session.userId) {
            const [rows] = await pool.query(
                'SELECT id, username, email FROM users WHERE id = ? AND is_active = 1',
                [req.session.userId]
            );
            
            if (rows.length > 0) {
                req.user = rows[0];
                return next();
            }
        }
        
        const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
        
        if (token) {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                const [rows] = await pool.query(
                    'SELECT id, username, email FROM users WHERE id = ? AND is_active = 1',
                    [decoded.userId]
                );
                
                if (rows.length > 0) {
                    req.user = rows[0];
                    req.session.userId = rows[0].id;
                    return next();
                }
            } catch (err) {}
        }
        
        res.status(401).json({
            success: false,
            message: 'Silakan login terlebih dahulu'
        });
    } catch (error) {
        console.error('Auth middleware error:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server'
        });
    }
};

module.exports = {
    authenticate
};
