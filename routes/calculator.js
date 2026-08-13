const express = require('express');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.post('/calculate', authenticate, async (req, res) => {
    try {
        let { X, Y, Z } = req.body;
        
        X = parseFloat(X);
        Y = parseFloat(Y);
        Z = parseFloat(Z);
        
        if (isNaN(X) || isNaN(Y) || isNaN(Z)) {
            throw new Error('Semua input harus berupa angka');
        }
        if (X <= 0 || Y <= 0) {
            throw new Error('X dan Y harus > 0 untuk log10');
        }
        
        const A = Math.log10(X) + Math.log10(Y) + Z;
        
        res.json({
            success: true,
            A: A.toFixed(6),
            unit: 'dBw',
            user: req.user.username
        });
        
    } catch (error) {
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
