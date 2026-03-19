import os
import eventlet
eventlet.monkey_patch()

from flask import Flask, request
from flask_socketio import SocketIO
import random

from coup.game import CoupGame
from coup.ppo_agent import PPOAgent
from coup.web_agent import WebAgent

app = Flask(__name__, static_folder='static', static_url_path='')
app.config['SECRET_KEY'] = 'coup_secret!'
socketio = SocketIO(app, async_mode='eventlet', cors_allowed_origins="*")

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

def game_thread_worker(sid, web_agent):
    try:
        if global_ai_agent is None:
            socketio.emit('game_error', {'error': 'AI model failed to load.'}, room=sid)
            return
            
        # Reset AI hidden state
        if hasattr(global_ai_agent, 'hidden_state'):
            global_ai_agent.hidden_state = global_ai_agent.model.reset_hidden(1, global_ai_agent.device)
            
        agents = [global_ai_agent, web_agent]
        random.shuffle(agents)
        
        # We need a custom emit function for the log
        def custom_emit(*args, **kwargs):
            socketio.emit(*args, **kwargs)
            
        game = CoupGame(agents, num_players=2, verbose=True)
        
        # Notify client of game start and identities
        socketio.emit('game_started', {
            'player_idx': agents.index(web_agent),
            'ai_idx': agents.index(global_ai_agent)
        }, room=sid)
        
        winner_idx = game.play_game()
        
        # Game Over logic
        ai_idx = agents.index(global_ai_agent)
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
        
    web_agent = WebAgent(sid, socketio.emit, name=data.get('player_name', 'Player'))
    agents_map[sid] = web_agent
    
    # Start game in background thread
    t = socketio.start_background_task(target=game_thread_worker, sid=sid, web_agent=web_agent)
    active_games[sid] = t

@socketio.on('player_action')
def handle_player_action(data):
    sid = request.sid
    if sid in agents_map:
        agents_map[sid].receive_input(data)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"Starting Coup server on port {port}")
    socketio.run(app, host='0.0.0.0', port=port)
