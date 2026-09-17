import { useState, useEffect } from 'react';

// Define the type for a player
interface Player {
    id: number;
    name: string;
    isReady: boolean;
}

const useMultiplayer = () => {
    const [players, setPlayers] = useState<Player[]>([]);
    const [currentPlayerIndex, setCurrentPlayerIndex] = useState<number>(0);

    // Function to add a player
    const addPlayer = (name: string) => {
        const newPlayer: Player = { id: players.length + 1, name, isReady: false };
        setPlayers([...players, newPlayer]);
    };

    // Function to toggle player readiness
    const togglePlayerReady = (id: number) => {
        setPlayers(players.map(player => 
            player.id === id ? { ...player, isReady: !player.isReady } : player
        ));
    };

    // Function to move to the next player
    const nextPlayer = () => {
        setCurrentPlayerIndex((currentPlayerIndex + 1) % players.length);
    };

    // Effect to log player changes
    useEffect(() => {
        console.log('Players updated:', players);
    }, [players]);

    return { players, addPlayer, togglePlayerReady, nextPlayer, currentPlayerIndex };
};

export default useMultiplayer;