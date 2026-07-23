import os
import secrets
import eventlet
eventlet.monkey_patch()

from flask import Flask, jsonify, request
from flask_socketio import SocketIO
import random

from coup.game import CoupGame
from coup.ppo_agent import PPOAgent
from coup.web_agent import WebAgent

app = Flask(__name__, static_folder='static', static_url_path='')
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY') or secrets.token_urlsafe(32)

DEFAULT_ALLOWED_ORIGINS = ','.join([
    'http://localhost:3000',
    'http://localhost:5173',
    'https://coup.austxu.dev',
    'https://staging.coup.austxu.dev',
])
allowed_origins = tuple(
    origin.strip() for origin in os.environ.get('COUP_ALLOWED_ORIGINS', DEFAULT_ALLOWED_ORIGINS).split(',')
    if origin.strip()
)
socketio = SocketIO(app, async_mode='eventlet', cors_allowed_origins=allowed_origins)

active_games = {}
agents_map = {}

# Preload model to save memory & time
print("Loading PPO AI Model...")
try:
    global_ai_agent = PPOAgent('versions/gen5/ppo_model_gen5.pt', device='cpu')
    global_ai_agent.name = "PPO-AI"
except Exception as e:
    print(f"Failed to load AI Model: {e}")
    global_ai_agent = None

@app.route('/')
def index():
    return app.send_static_file('index.html')


@app.route('/health')
def health():
    ready = global_ai_agent is not None
    response = jsonify({
        'status': 'ok' if ready else 'degraded',
        'model': 'gen5-1v1' if ready else 'unavailable',
        'ready': ready,
    })
    return response, 200 if ready else 503


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get('Origin')
    if origin in allowed_origins:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Vary'] = 'Origin'
    return response

def game_thread_worker(sid, web_agent):
    try:
        if global_ai_agent is None:
            socketio.emit('game_error', {'error': 'AI model failed to load.'}, room=sid)
            return
            
        # Share the loaded, immutable model weights, but keep recurrent state per game.
        ai_agent = global_ai_agent.clone_for_game()

        agents = [ai_agent, web_agent]
        random.shuffle(agents)
        
        # We need a custom emit function for the log
        def custom_emit(*args, **kwargs):
            socketio.emit(*args, **kwargs)
            
        game = CoupGame(agents, num_players=2, verbose=True)
        
        # Notify client of game start and identities
        socketio.emit('game_started', {
            'player_idx': agents.index(web_agent),
            'ai_idx': agents.index(ai_agent)
        }, room=sid)
        
        winner_idx = game.play_game()
        
        # Game Over logic
        ai_idx = agents.index(ai_agent)
        ai_player = game.state.players[ai_idx]
        ai_cards = [c.name for c in ai_player.cards]
        
        socketio.emit('game_over', {
            'winner': game.state.names[winner_idx] if winner_idx is not None else 'Draw',
            'ai_final_cards': ai_cards
        }, room=sid)
        
    except Exception as e:
        print(f"Game error for {sid}: {e}")
        socketio.emit('game_error', {'error': str(e)}, room=sid)
    finally:
        if sid in active_games:
            del active_games[sid]
        if sid in agents_map:
            del agents_map[sid]

@socketio.on('connect')
def connect():
    print(f"Client connected: {request.sid}")

@socketio.on('disconnect')
def disconnect():
    print(f"Client disconnected: {request.sid}")
    if request.sid in agents_map:
        # Push a sentinel to unblock the agent if it's waiting
        agents_map[request.sid].receive_input({'error': 'disconnected'})
    
@socketio.on('start_game')
def handle_start_game(data):
    sid = request.sid
    print(f"Starting game for {sid}")
    
    if sid in active_games:
        socketio.emit('game_error', {'error': 'Game already in progress.'}, room=sid)
        return
        
    if not isinstance(data, dict):
        socketio.emit('game_error', {'error': 'Invalid game request.'}, room=sid)
        return
    player_name = str(data.get('player_name', 'Player')).strip()[:40] or 'Player'
    web_agent = WebAgent(sid, socketio.emit, name=player_name)
    agents_map[sid] = web_agent
    
    # Start game in background thread
    t = socketio.start_background_task(target=game_thread_worker, sid=sid, web_agent=web_agent)
    active_games[sid] = t

@socketio.on('player_action')
def handle_player_action(data):
    sid = request.sid
    if sid in agents_map and isinstance(data, dict):
        agents_map[sid].receive_input(data)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"Starting Coup server on port {port}")
    socketio.run(app, host='0.0.0.0', port=port)
