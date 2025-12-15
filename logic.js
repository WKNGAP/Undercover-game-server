// logic.js

/**
 * Generates a random float between 0 and 1
 */
function getRandom() {
    return Math.random();
}

/**
 * The Recursive Role Assigner
 * Handles the edge case where multiple people have the same number 
 * but sit on the boundary of a role change.
 */
function assignRoles(players, spyCount, blankCount) {
    const totalPlayers = players.length;
    const blankLimit = blankCount;
    const spyLimit = blankCount + spyCount;

    // 1. Assign initial random numbers
    players.forEach(p => {
        p.rng = getRandom(); 
        p.role = null; // Reset role
    });

    // 2. Sort by number (Ascending)
    // If numbers are equal, we don't swap yet, we handle logic below
    players.sort((a, b) => a.rng - b.rng);

    // 3. Assign Roles based on index
    // Indices [0 ... blankLimit-1] -> Blank
    // Indices [blankLimit ... spyLimit-1] -> Spy
    // Indices [spyLimit ... end] -> Civilian
    
    // We must detect "Boundary Ties". 
    // Example: We need 1 Blank. Player[0] has 0.5, Player[1] has 0.5.
    // Both want to be Blank, but only one can.
    
    // Check Blank Boundary
    resolveBoundaryConflict(players, blankLimit);
    
    // Check Spy Boundary (The line between Spy and Civilian)
    resolveBoundaryConflict(players, spyLimit);

    // Final Assignment
    players.forEach((p, index) => {
        if (index < blankLimit) {
            p.role = 'Blank';
        } else if (index < spyLimit) {
            p.role = 'Spy';
        } else {
            p.role = 'Civilian';
        }
    });

    return players;
}

/**
 * Helper to resolve ties at a specific index boundary
 */
function resolveBoundaryConflict(players, splitIndex) {
    if (splitIndex <= 0 || splitIndex >= players.length) return;

    const boundaryValue = players[splitIndex - 1].rng;
    const nextValue = players[splitIndex].rng;

    // If the person 'in' the group and the person 'out' of the group 
    // have the same number, we have a conflict.
    if (boundaryValue === nextValue) {
        console.log(`Tie detected at boundary ${splitIndex}. Resolving...`);
        
        // Find all players sharing this specific tied value
        const tiedPlayers = players.filter(p => p.rng === boundaryValue);
        
        // Generate NEW numbers for these specific players
        tiedPlayers.forEach(p => p.rng = getRandom());
        
        // Re-sort the WHOLE list based on new numbers
        // (This is recursive in concept, but simpler to just re-sort the master list)
        players.sort((a, b) => a.rng - b.rng);
        
        // Check again recursively in case the new numbers also tied (extremely rare)
        resolveBoundaryConflict(players, splitIndex);
    }
}

module.exports = { assignRoles };