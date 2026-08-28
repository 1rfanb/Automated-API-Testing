import app from "./server.js"

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`listening on port 5000 http://localhost:${PORT}`)
});