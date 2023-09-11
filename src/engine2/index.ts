export * from "./model"
export * from "./state"
export * from "./queries"
export * from "./requests"
export * from "./storage"
export * from "./projections"
export * from "./commands"

import {authHandler} from "./queries"
import {handleAuth} from "./commands"

authHandler.set(handleAuth)