import { createUser, getUserByEmail } from "db/users.js";
import express from "express"
import { authentication, random } from "helpers/index.js";

export const register = async (req : express.Request, res: express.Response) => {
    try{
        const {email, password, username} = req.body;
        if (!email || !password || !username){
            return res.status(404).send({
                error: "email, password or username is missing"
            })
        }
        const existingUser = await getUserByEmail(email);
        if (existingUser){
            return res.status(400).send({
                message: "user exists"
            })
        }

        const salt = random();
        const user = await createUser({
            email, username, 
            authentication:{
                salt,
                password: authentication(salt, password)
            }
        })

        return res.status(200).send({
            message: "user created successfully",
            
        })
    }
    catch(error){
        console.log(error)
        return res.status(400).send({
            error: error
        })
    }
}