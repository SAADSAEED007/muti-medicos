const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/inventory', require('../api/inventory'));
app.use('/api', require('../api/transactions'));
const server = app.listen(0, '127.0.0.1', async () => {
  const id = process.argv[2];
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/new`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ _id: id, order: id, status: 1, date: '2030-01-01T00:00:00.000Z',
      items: [{ id: 1, product_name: 'Test medicine', price: '10.00', quantity: 2 }],
      discount: 0, tax: 0, total: 20, paid: 20 }),
  });
  console.log(response.status);
  server.close(() => { require('../api/sqlite').db.close(); });
});
