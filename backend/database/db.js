import mysql from "mysql2";

const db = mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "api_testing"
});

db.connect((err) => {
    if (err) {
        console.error(
            "MySQL connection failed:",
            err.message
        );
        return;
    }

    console.log(
        "MySQL connected successfully!"
    );
});

export default db;