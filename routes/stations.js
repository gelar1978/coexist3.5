const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { pool } = require('../db/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Setup Multer (simpan di memori sementara)
const upload = multer({ storage: multer.memoryStorage() });

// ==================== GET ALL STATIONS ====================
router.get('/', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM stations ORDER BY id DESC');
        res.json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error('Error fetching stations:', error);
        res.status(500).json({ success: false, message: 'Gagal mengambil data stasiun' });
    }
});

// ==================== UPLOAD EXCEL (Parse JSON) ====================
// Kita tidak pakai multer karena proxy PHP tidak support multipart/form-data dengan baik.
// Client (browser) akan mem-parse Excel dan mengirim array JSON ke endpoint ini.
router.post('/upload', authenticate, async (req, res) => {
    try {
        const rawData = req.body.data;
        
        if (!rawData || !Array.isArray(rawData) || rawData.length === 0) {
            return res.status(400).json({ success: false, message: 'Data Excel kosong atau tidak valid' });
        }

        let insertedCount = 0;
        let skippedCount = 0;

        // Loop setiap baris dan masukkan ke database
        for (const row of rawData) {
            // Mapping nama kolom dinamis (karena ada Ext C-band & Std C-band)
            const name = row['Earth Station Name'] || row['Name'] || row['Nama Stasiun'];
            const lat = row['Lat Dec'] || row['Latitude'];
            const lng = row['Long Dec'] || row['Longitude'];
            
            // Opsional
            const stationId = row['ID Stasiun Bumi'] || null;
            const operatingAgency = row['Operating Agency'] || null;
            const address = row['Alamat'] || null;
            const province = row['Provinsi'] || null;
            const usageType = row['Jenis Penggunaan'] || null;
            const antenna = row['Antenna Diameter'] || null;
            const bandwidth = row['Bandwidth (MHz)'] || null;
            const frequency = row['Frequency (MHz)'] || row['Downlink (MHz)'] || null;
            const isr = row['Nomor ISR'] || null;

            // Validasi data wajib
            if (!name || lat == null || lng == null) {
                skippedCount++;
                continue;
            }

            try {
                // Insert dengan IGNORE untuk skip duplikat berdasarkan UNIQUE KEY (name, lat, lng)
                const [result] = await pool.query(`
                    INSERT IGNORE INTO stations 
                    (name, lat, lng, station_id, operating_agency, address, province, usage_type, antenna_diameter, frequency, bandwidth, isr_number) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [name, parseFloat(lat), parseFloat(lng), stationId, operatingAgency, address, province, usageType, antenna, frequency, bandwidth, isr]);
                
                if (result.affectedRows > 0) {
                    insertedCount++;
                } else {
                    skippedCount++; // Duplikat
                }
            } catch (err) {
                console.error('Error insert row:', err.message);
                skippedCount++;
            }
        }

        // Catat aktivitas
        try {
            await pool.query(
                'INSERT INTO user_logs (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                [req.user.id, 'upload_stations', req.ip || req.connection.remoteAddress, req.headers['user-agent']]
            );
        } catch(e) {}

        res.json({
            success: true,
            message: `Berhasil memproses Excel. Data baru dimasukkan: ${insertedCount}. Data dilewati/duplikat: ${skippedCount}.`
        });

    } catch (error) {
        console.error('Upload excel error:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan server saat memproses file Excel' });
    }
});

module.exports = router;
