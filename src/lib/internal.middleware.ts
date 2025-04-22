import express from 'express';

const internalServer = express();

internalServer.use(express.json());
internalServer.use(express.urlencoded({ extended: true }));

export default internalServer;
