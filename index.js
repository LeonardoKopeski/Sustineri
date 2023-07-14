const express = require("express")
const app = express()
const server = require("http").createServer(app)
const io = require("socket.io")(server)
const fs = require("fs")

const questionString = fs.readFileSync("./questions.txt")
const questions = questionString.toString().split("\n")

const STATUS = {
    OK: 0,
    ROOM_NOT_FOUND: 1,
    NOT_JOINED: 2,
    INVALID_TEAM: 3,
    STARTED_ROOM: 4,
    NOT_STARTED_ROOM: 5,
    WRONG_QUESTION_ANSWER: 6,
    NO_TEAM: 7,
    ANSWERED_CORRECTLY: 8,
    SKIPPED_QUESTION: 9,
}

var rooms = []
var sessions = {}

app.use(express.static('web'))

app.get("/checkroom",(req,res)=>{
    var room = rooms.filter((x)=>x.publicID == req.query.id)
    if(!room[0]){
        res.status(404).send("Room not found")
    }else{
        res.send("Found")
    }
})


function getQuestionData(id){
    var q = questions[id]
    var answerLength = q.match(/\*.+\*/)[0].length - 2
    return {
        title: q.replace(/\*.+\*/g, "*"),
        answerType: answerLength <= 5? "SHORT":
            answerLength <= 10? "MEDIUM":
            answerLength <= 15? "BIG":
            "SUPER_BIG"
    }
}

io.on("connection", (socket)=>{
    socket.on("room.create", ()=>{
        var id = Math.floor(Math.random() * 1000000)
        rooms.push({
            publicID: id,
            owner: socket.id,
            started: false,
            questions: [],
            teams: [
                {
                    users: [],
                },
                {
                    users: [],
                    pontuation: 0,
                    question: Math.floor(Math.random()*questions.length)
                },
                {
                    users: [],
                    pontuation: 0,
                    question: Math.floor(Math.random()*questions.length)
                },
                {
                    users: [],
                    pontuation: 0,
                    question: Math.floor(Math.random()*questions.length)
                },
                {
                    users: [],
                    pontuation: 0,
                    question: Math.floor(Math.random()*questions.length)
                },
            ]
        })

        socket.emit("room.update.publicID", id)
    })
    socket.on("room.start", ()=>{
        var roomIndex = -1
        for(var r in rooms){
            if(rooms[r].owner == socket.id){
                roomIndex = r
                break
            }
        }
        if(roomIndex == -1){
            socket.emit("room.start.ack", {status: STATUS.ROOM_NOT_FOUND})
            return
        }

        rooms[roomIndex].started = true

        socket.emit("room.start.ack", {status: STATUS.OK})

        for(var teamIndex in rooms[roomIndex].teams){
            if(teamIndex == 0) continue
            var team = rooms[roomIndex].teams[teamIndex]
            for(var user of team.users){
                io.to(user.socket).emit("room.update.question",{
                    questionData: getQuestionData(team.question),
                    cause: null
                })
            }
        }
        setTimeout(()=>{
            rooms[roomIndex].started = false
            for(var teamIndex in rooms[roomIndex].teams){
                if(teamIndex == 0) continue
                var team = rooms[roomIndex].teams[teamIndex]
                for(var user of team.users){
                    io.to(user.socket).emit("room.timeout")
                }
            }
        }, 10*60*1000 + 1)
    })
    socket.on("room.join", (roomID, username)=>{
        var roomIndex = -1
        for(var r in rooms){
            if(rooms[r].publicID == roomID){
                roomIndex = r
                break
            }
        }
        if(roomIndex == -1){
            socket.emit("room.join.ack", {status: STATUS.ROOM_NOT_FOUND})
            return
        }

        if(rooms[roomIndex].started){
            socket.emit("room.join.ack", {status: STATUS.STARTED_ROOM})
            return
        }

        rooms[roomIndex].teams[0].users.push({
            name: username,
            socket: socket.id
        })
        sessions[socket.id] = {
            room: roomID,
            name: username,
            team: 0
        }

        socket.emit("room.join.ack", {status: STATUS.OK})
        io.to(rooms[roomIndex].owner).emit("room.event.new_user",{
            name: username,
            userID: socket.id,
        })
    })
    socket.on("user.update.team", (newteam)=>{
        var session = sessions[socket.id]
        if(!session) {
            socket.emit("user.update.team.ack", {status: STATUS.NOT_JOINED})
            return
        }

        var roomIndex = -1
        for(var r in rooms){
            if(rooms[r].publicID == session.room){
                roomIndex = r
                break
            }
        }
        if(roomIndex == -1){
            socket.emit("user.update.team.ack", {status: STATUS.ROOM_NOT_FOUND})
            return
        }

        if(rooms[roomIndex].started){
            socket.emit("user.update.team.ack", {status: STATUS.STARTED_ROOM})
            return
        }
        
        newteam = parseInt(newteam)
        if(isNaN(newteam) || newteam < 0 || newteam > 4){
            socket.emit("user.update.team.ack", {status: STATUS.INVALID_TEAM})
            return
        }

        rooms[roomIndex].teams[session.team].users = rooms[roomIndex].teams[session.team].users.filter(x=>{
            if(x.socket == socket.id) return false
            return true
        })
        rooms[roomIndex].teams[newteam].users.push({
            name: session.name,
            socket: socket.id
        })
        sessions[socket.id].team = newteam

        socket.emit("user.update.team.ack", {status: STATUS.OK, team: newteam})
        io.to(rooms[roomIndex].owner).emit("room.update.user_team",{
            userID: socket.id,
            team: newteam
        })
    })

    socket.on("user.send_answer",(answer)=>{
        var session = sessions[socket.id]
        if(!session) {
            socket.emit("user.send_answer.ack", {status: STATUS.NOT_JOINED})
            return
        }

        var roomIndex = -1
        for(var r in rooms){
            if(rooms[r].publicID == session.room){
                roomIndex = r
                break
            }
        }
        if(roomIndex == -1){
            socket.emit("user.send_answer.ack", {status: STATUS.ROOM_NOT_FOUND})
            return
        }

        if(!rooms[roomIndex].started){
            socket.emit("user.send_answer.ack", {status: STATUS.NOT_STARTED_ROOM})
            return
        }

        var userTeam = session.team
        if(userTeam == 0){
            socket.emit("user.send_answer.ack", {status: STATUS.NO_TEAM})
            return
        }

        var actualQuestionID = rooms[roomIndex].teams[session.team].question
        var rightAnswer = questions[actualQuestionID]
            .toLowerCase()
            .match(/\*.+\*/)[0]
            .replaceAll("*", "")
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, "")
        var sentAnswer = answer
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, "")
        if(rightAnswer != sentAnswer){
            socket.emit("user.send_answer.ack", {status: STATUS.WRONG_QUESTION_ANSWER})
            return
        }

        socket.emit("user.send_answer.ack", {status: STATUS.OK})
        var nextQuestion = Math.floor(Math.random()*questions.length)
        rooms[roomIndex].teams[userTeam].question = nextQuestion
        for(var user of rooms[roomIndex].teams[userTeam].users){
            io.to(user.socket).emit("room.update.question",{
                questionData: getQuestionData(nextQuestion),
                cause: user.socket == socket.id? null:STATUS.ANSWERED_CORRECTLY
            })
        }

        rooms[roomIndex].teams[userTeam].pontuation += 100
        var owner = rooms[roomIndex].owner
        io.to(owner).emit("room.update.pontuation", {
            team: userTeam,
            pontuation: rooms[roomIndex].teams[userTeam].pontuation
        })
    })

    socket.on("user.skip_question",()=>{
        var session = sessions[socket.id]
        if(!session) {
            socket.emit("user.skip_question.ack", {status: STATUS.NOT_JOINED})
            return
        }

        var roomIndex = -1
        for(var r in rooms){
            if(rooms[r].publicID == session.room){
                roomIndex = r
                break
            }
        }
        if(roomIndex == -1){
            socket.emit("user.skip_question.ack", {status: STATUS.ROOM_NOT_FOUND})
            return
        }

        if(!rooms[roomIndex].started){
            socket.emit("user.skip_question.ack", {status: STATUS.NOT_STARTED_ROOM})
            return
        }

        var userTeam = session.team
        if(userTeam == 0){
            socket.emit("user.skip_question.ack", {status: STATUS.NO_TEAM})
            return
        }

        socket.emit("user.skip_question.ack", {status: STATUS.OK})
        var nextQuestion = Math.floor(Math.random()*questions.length)
        rooms[roomIndex].teams[userTeam].question = nextQuestion
        for(var user of rooms[roomIndex].teams[userTeam].users){
            io.to(user.socket).emit("room.update.question",{
                questionData: getQuestionData(nextQuestion),
                cause: user.socket == socket.id? null:STATUS.SKIPPED_QUESTION
            })
        }

        rooms[roomIndex].teams[userTeam].pontuation -= 50
        var owner = rooms[roomIndex].owner
        io.to(owner).emit("room.update.pontuation", {
            team: userTeam,
            pontuation: rooms[roomIndex].teams[userTeam].pontuation
        })
    })

    socket.on("disconnect", ()=>{
        for(var index in rooms){
            var room = rooms[index]
            var disconnectedOwner = room.owner == socket.id
            for(var teamIndex in room.teams){
                var team = room.teams[teamIndex]
                for(var user of team.users){
                    if(disconnectedOwner){
                        io.to(user.socket).emit("room.close")
                    }
                    if(user.socket == socket.id){
                        io.to(room.owner).emit("room.event.user_out",{
                            name: user.name,
                            userID: socket.id
                        })
                        rooms[index].teams[teamIndex].users = rooms[index].teams[teamIndex].users.filter(x=>x.socket != socket.id)
                    }
                }
            }
            if(disconnectedOwner){
                rooms[index].owner = ""
            }
        }

        rooms = rooms.filter((x)=>x.owner != "")

        if(sessions[socket.id]){
            delete sessions[socket.id]
        }
    })
})

process.on("uncaughtException", (err, origin)=>{
    console.log("UncaughtException!")
    console.log(err)
    console.log(origin)
    io.emit("server.uncaught_exception_warning")
})

const port = process.env.PORT || 3000
server.listen(port,()=>{
    console.log("running")
})