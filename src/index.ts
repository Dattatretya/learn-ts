import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import http from 'http';
import compression from 'compression';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import router from './router/index.js';
import { logger } from './utils/logger.js';

dotenv.config();


const app = express();
const PORT = process.env.PORT

app.use(cors({
    credentials: true,
}));

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(compression());

app.use("/", router())


const server = http.createServer(app);

async function dbConnect () {
    try{
    const connect = await mongoose.connect(process.env.MONGOURL || '');
    logger.info('Connected to MongoDB', { host: connect.connection.host });
    }
    catch(err){
        logger.error('Error connecting to MongoDB', err);
    }
}

server.listen(PORT, async () => {
    dbConnect();
    logger.info(`Server is running on http://localhost:${PORT}`, { port: PORT });
})