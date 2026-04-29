const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Render test works'));
app.listen(3000, () => console.log('Test server running'));