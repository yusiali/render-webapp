const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv').config();

// Create express app
const app = express();
const port = process.env.PORT || 3000;

// Log which database variables are set (names only, never values)
console.log('DB env set:', ['PSQL_HOST','PSQL_USER','PSQL_DATABASE','PSQL_PASSWORD','PSQL_PORT'].map(k => k + '=' + (process.env[k] ? 'yes' : 'NO')).join(' '));

// Create pool
const pool = new Pool({
    user: process.env.PSQL_USER,
    host: process.env.PSQL_HOST,
    database: process.env.PSQL_DATABASE,
    password: process.env.PSQL_PASSWORD,
    port: process.env.PSQL_PORT,
    ssl: {rejectUnauthorized: false}
});

// Add process hook to shutdown pool
process.on('SIGINT', function() {
    pool.end();
    console.log('Application successfully shutdown');
    process.exit(0);
});

app.set("view engine", "ejs");
app.use(express.json());

app.get('/', (req, res) => {
    const data = {name: 'Yusuf'};
    res.render('index', data);
});

app.get('/user', (req, res) => {
    teammembers = []
    pool
        .query('SELECT * FROM teammembers;')
        .then(query_res => {
            for (let i = 0; i < query_res.rowCount; i++){
                teammembers.push(query_res.rows[i]);
            }
            const data = {teammembers: teammembers};
            console.log(teammembers);
            res.render('user', data);        
        })
        .catch(err => {
            const detail = err.message || (err.errors || []).map(e => e.code + ' ' + e.address + ':' + e.port).join(', ') || err.code || String(err);
            console.error('Query failed:', err);
            res.status(500).send('Database error: ' + detail + ' | host set: ' + (process.env.PSQL_HOST ? 'yes' : 'NO'));
        });
});

// ---- Cashier ----
const CASHIER_EMPLOYEE_ID = parseInt(process.env.CASHIER_EMPLOYEE_ID || '1', 10);

app.get('/cashier', (req, res) => res.render('cashier'));

app.get('/api/menu', async (req, res) => {
    try {
        const cats = await pool.query('SELECT categoryID AS id, name FROM category ORDER BY categoryID');
        const prods = await pool.query('SELECT productID AS id, categoryID AS category, name, cost FROM product ORDER BY productID');
        res.json({categories: cats.rows, products: prods.rows});
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

// Inserts order + items and decrements inventory in one transaction
app.post('/api/orders', async (req, res) => {
    const {items, paymentMethod} = req.body || {};
    if (!Array.isArray(items) || items.length === 0 ||
        items.some(i => !Number.isInteger(i.productId) || !Number.isInteger(i.quantity) || i.quantity <= 0)) {
        return res.status(400).json({error: 'Invalid order'});
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE orderItem ADD COLUMN IF NOT EXISTS customizations VARCHAR(255)');
        await client.query('LOCK TABLE orders, orderItem IN EXCLUSIVE MODE');
        const orderId = (await client.query('SELECT COALESCE(MAX(orderID),0)+1 AS n FROM orders')).rows[0].n;
        let itemId = (await client.query('SELECT COALESCE(MAX(orderItemID),0)+1 AS n FROM orderItem')).rows[0].n;

        // Price from the DB, never from the client
        const ids = items.map(i => i.productId);
        const priceRows = (await client.query('SELECT productID AS id, cost FROM product WHERE productID = ANY($1)', [ids])).rows;
        const prices = new Map(priceRows.map(r => [r.id, parseFloat(r.cost)]));
        let subtotal = 0;
        for (const i of items) {
            if (!prices.has(i.productId)) throw new Error('Unknown product ' + i.productId);
            subtotal += prices.get(i.productId) * i.quantity;
        }
        subtotal = Math.round(subtotal * 100) / 100;

        await client.query(
            'INSERT INTO orders (orderID, employeeID, date, subtotal, tax, total, paymentMethod) VALUES ($1,$2,CURRENT_TIMESTAMP,$3,0,$3,$4)',
            [orderId, CASHIER_EMPLOYEE_ID, subtotal, (paymentMethod || 'CARD').toUpperCase()]);
        for (const i of items) {
            await client.query(
                'INSERT INTO orderItem (orderItemID, orderID, productID, quantity, sugarLevel, iceLevel, customizations) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                [itemId++, orderId, i.productId, i.quantity, i.sugar || '100%', i.ice || 'Regular', i.customizations || '']);
        }
        await client.query(
            `UPDATE inventory i SET inventory = i.inventory - used.amount FROM (
               SELECT pi.ingredientID, SUM(oi.quantity * pi.amount) AS amount
               FROM orderItem oi JOIN productIngredient pi ON pi.productID = oi.productID
               WHERE oi.orderID = $1 GROUP BY pi.ingredientID) AS used
             WHERE i.ingredientID = used.ingredientID`, [orderId]);
        await client.query('COMMIT');
        res.json({orderId, total: subtotal});
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Order failed:', err);
        res.status(500).json({error: err.message});
    } finally {
        client.release();
    }
});

app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`);
});
