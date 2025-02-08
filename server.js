const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// API Football Data configuration
const FOOTBALL_API_TOKEN = 'f7268f03ecc54a47bfa88f0f60ff0d54';
const FOOTBALL_API_URL = 'https://api.football-data.org/v4/matches';

// Initialize game state (original game)
let gameState = {
    currentPlayer: 'Ruperto',
    score: {'Ruperto': 60000, 'Juan': 60000, 'Mauricio': 60000},
    diamondStates: [],
    goldBarStates: [],
    rubyStates: [],
    trophyStates: [],
    takenRowsByPlayer: {Ruperto: [], Juan: [], Mauricio: []},
    takenCount: 0,
    timeLeft: 10,
};

// Initialize betting state
let bettingState = {
    activeBets: {},
    matchesInPlay: {}
};

// Original game functions
const initializeBoard = () => {
    const tokens = [
        ...Array(8).fill({ type: 'win', points: 20000 }),
        ...Array(8).fill({ type: 'lose', points: -23000 })
    ];
    const shuffledTokens = shuffleArray([...tokens]);

    gameState.diamondStates = shuffledTokens.slice(0, 4).map(token => ({ ...token, emoji: '💎', available: true }));
    gameState.goldBarStates = shuffledTokens.slice(4, 8).map(token => ({ ...token, emoji: '💰', available: true }));
    gameState.rubyStates = shuffledTokens.slice(8, 12).map(token => ({ ...token, emoji: '🔴', available: true }));
    gameState.trophyStates = shuffledTokens.slice(12, 16).map(token => ({ ...token, emoji: '🏆', available: true }));

    gameState.takenCount = 0;
    Object.keys(gameState.takenRowsByPlayer).forEach(player => {
        gameState.takenRowsByPlayer[player] = [];
    });
};

const shuffleArray = (array) => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};

// Initialize the board at the start
initializeBoard();

// Middleware
app.use(express.static('public'));
app.use(express.json());

// Football betting routes
// Modificar el endpoint de partidos para incluir partidos FINALIZADOS
app.get('/api/matches/:leagueCode', async (req, res) => {
    try {
        const { leagueCode } = req.params;
        // Obtener tanto partidos EN VIVO como FINALIZADOS de los últimos 7 días
        const hoy = new Date();
        const haceSieteDias = new Date(hoy.getTime() - (7 * 24 * 60 * 60 * 1000));
        
        const [respuestaEnVivo, respuestaFinalizados] = await Promise.all([
            fetch(
                `${FOOTBALL_API_URL}/competitions/${leagueCode}/matches?status=LIVE`,
                {
                    headers: {
                        'X-Auth-Token': FOOTBALL_API_TOKEN
                    }
                }
            ),
            fetch(
                `${FOOTBALL_API_URL}/competitions/${leagueCode}/matches?status=FINISHED&dateFrom=${haceSieteDias.toISOString().split('T')[0]}&dateTo=${hoy.toISOString().split('T')[0]}`,
                {
                    headers: {
                        'X-Auth-Token': FOOTBALL_API_TOKEN
                    }
                }
            )
        ]);

        if (!respuestaEnVivo.ok || !respuestaFinalizados.ok) {
            throw new Error('Error en la API');
        }

        const [datosEnVivo, datosFinalizados] = await Promise.all([
            respuestaEnVivo.json(),
            respuestaFinalizados.json()
        ]);

        const datosCombinados = {
            matches: {
                live: datosEnVivo.matches || [],
                finished: datosFinalizados.matches || []
            }
        };

        bettingState.matchesInPlay[leagueCode] = datosCombinados.matches.live;
        res.json(datosCombinados);
    } catch (error) {
        console.error('Error al obtener partidos:', error);
        res.status(500).json({ error: 'Error al obtener partidos' });
    }
});
// Place bet endpoint
app.post('/api/bet', (req, res) => {
    const { matchId, betType, amount, userId } = req.body;
    
    if (!gameState.score[userId]) {
        return res.status(400).json({ error: 'Usuario no encontrado' });
    }

    if (gameState.score[userId] < amount) {
        return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    // Registrar la apuesta
    const betId = Date.now().toString();
    bettingState.activeBets[betId] = {
        userId,
        matchId,
        betType,
        amount,
        timestamp: new Date(),
        status: 'active'
    };

    // Descontar el monto de la apuesta
    gameState.score[userId] -= amount;

    res.json({
        betId,
        currentBalance: gameState.score[userId]
    });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('A user connected');
    socket.emit('initialState', gameState);

    // Original game events
    socket.on('updateState', (updatedState) => {
        gameState = updatedState;
        
        if (gameState.takenCount >= 16) {
            resetGame();
        }
        
        io.emit('stateChanged', gameState);
    });

    socket.on('registerPlayer', (username) => {
        if (!gameState.score[username]) {
            gameState.score[username] = 60000;
            gameState.takenRowsByPlayer[username] = [];
        }
        io.emit('updatePlayersList', Object.keys(gameState.score));
    });

    socket.on('takeToken', (data) => {
        const { player, rowId, index } = data;
        const row = gameState[rowId];
        
        if (row[index].available) {
            row[index].available = false;
            gameState.takenCount++;
            gameState.takenRowsByPlayer[player].push(rowId);
            
            if (typeof gameState.score[player] !== 'number') {
                gameState.score[player] = 60000;
            }
            gameState.score[player] += row[index].points;
            
            if (gameState.score[player] < 0) {
                gameState.score[player] = 0;
            }
            
            if (gameState.takenCount >= 16) {
                resetGame();
            }
            
            io.emit('stateChanged', gameState);
        }
    });

    // New betting events
    socket.on('placeBet', (betData) => {
        const { userId, matchId, betType, amount } = betData;
        
        if (gameState.score[userId] >= amount) {
            const betId = Date.now().toString();
            bettingState.activeBets[betId] = {
                userId,
                matchId,
                betType,
                amount,
                timestamp: new Date(),
                status: 'active'
            };

            gameState.score[userId] -= amount;
            
            io.emit('betPlaced', {
                betId,
                userId,
                currentBalance: gameState.score[userId]
            });
            
            io.emit('stateChanged', gameState);
        }
    });

    socket.on('disconnect', () => {
        console.log('A user disconnected');
    });
});

// Function to reset the game
const resetGame = () => {
    initializeBoard();
    gameState.currentPlayer = 'Ruperto';
    gameState.timeLeft = 10;
    io.emit('gameReset', gameState);
};

// Start updating matches every minute
setInterval(async () => {
    try {
        for (const leagueCode of ['CL', 'PL', 'PD', 'SA', 'BL1', 'FL1']) {
            const response = await fetch(
                `${FOOTBALL_API_URL}/competitions/${leagueCode}/matches?status=LIVE`,
                {
                    headers: {
                        'X-Auth-Token': FOOTBALL_API_TOKEN
                    }
                }
            );

            if (response.ok) {
                const data = await response.json();
                bettingState.matchesInPlay[leagueCode] = data.matches || [];
                io.emit('matchesUpdated', { leagueCode, matches: data.matches || [] });
            }
        }
    } catch (error) {
        console.error('Error updating matches:', error);
    }
}, 60000);

server.listen(3000, () => {
    console.log('Server running on port 3000');
});